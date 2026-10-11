'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const tasks = new Map();
const albums = new Map();
const chapters = new Map();
const images = new Map();
const clone = (value) => value == null ? value : structuredClone(value);
let lockHook = null;
let imageHook = null;
let requests = 0;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const turn = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate, label) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await turn();
  }
  assert.fail(label);
}

// 只替换存储与网络边界；实际 DownloadManager 的恢复、调度、锁内执行、
// 并行 worker 和失败收口逻辑仍完整运行。存储返回克隆以模拟 IndexedDB。
globalThis.__downloadTest = {
  apiRequest: async (route, options) => (await fetch('/api' + route, options)).json(),
  imgSrc: () => '/cover', selectedDataSource: () => 'builtin',
  needsScramble: () => false, decodeFromBlob: async (blob) => ({ blob }),
  supportsOfflineWebLocks: () => true,
  withOfflineLibraryLock: async (_mode, fn) => fn({}),
  withOfflineTaskAidLock: async (_aid, fn) => fn({}),
  withOfflineTaskAidLockOnly: async (_aid, fn) => fn({}),
  withOfflineAidLockOnly: async (_aid, fn) => fn({}),
  withOfflineAidLock: async (aid, fn) => {
    if (lockHook) await lockHook(aid);
    return fn({});
  },
  listDownloadTasks: async () => [...tasks.values()].map(clone),
  getDownloadTask: async (id) => clone(tasks.get(id)),
  putDownloadTask: async (task) => tasks.set(task.id, clone(task)),
  deleteDownloadTask: async (id) => tasks.delete(id),
  getOfflineAlbum: async (aid) => clone(albums.get(aid)),
  putOfflineAlbum: async (album) => albums.set(album.aid, clone(album)),
  getOfflineChapter: async (aid, id) => clone(chapters.get(`${aid}:${id}`)),
  putOfflineChapter: async (chapter) => chapters.set(`${chapter.aid}:${chapter.photoId}`, clone(chapter)),
  listOfflineChapters: async (aid) => [...chapters.values()].filter((row) => row.aid === aid).map(clone),
  getOfflineImage: async (aid, id, index) => clone(images.get(`${aid}:${id}:${index}`)),
  putOfflineImage: async (image) => {
    if (imageHook) await imageHook(image);
    images.set(`${image.aid}:${image.photoId}:${image.index}`, clone(image));
  },
  listOfflineImages: async (aid, id) => [...images.values()]
    .filter((row) => row.aid === aid && row.photoId === id).map(clone),
  deleteOfflineImage: async (aid, id, index) => images.delete(`${aid}:${id}:${index}`),
  deleteOfflineChapter: async () => {}, deleteOfflineAlbum: async () => {},
  clearOfflineLibrary: async () => {},
};
global.fetch = async (url) => {
  requests++;
  if (url.startsWith('/api/chapter')) return Response.json({ data: {
    images: [0, 1].map((index) => ({ page: index + 1, name: `${index + 1}.jpg`, url: `https://images.test/${index}.jpg` })),
  } });
  if (url.startsWith('/api/img')) return new Response(new Blob(['image'], { type: 'image/jpeg' }));
  throw new Error(`Unexpected request: ${url}`);
};

function queuedTask(id = 'restored') {
  return {
    id, aid: '42', status: 'queued', ownerId: 'closed-tab',
    request: { chapterIds: null, concurrency: 2, cacheCover: false, decode: false,
      album: { id: '42', name: 'Test', series: [{ id: '421', name: 'Chapter' }] } },
    progress: {}, chapters: [], errors: [],
  };
}

(async () => {
  const file = path.join(__dirname, '../public/js/downloads.js');
  const source = fs.readFileSync(file, 'utf8').replace(
    /import\s*\{([^}]+)\}\s*from\s*'[^']+';/g,
    (_match, bindings) => `const { ${bindings} } = globalThis.__downloadTest;`,
  );
  const { DownloadManager, downloads } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  await downloads.ready;
  const only = process.argv[2];

  if (!only || only === 'restore') {
    tasks.set('restored', queuedTask());
    const manager = new DownloadManager();
    await manager.ready;
    await until(() => tasks.get('restored')?.status === 'completed', '重开页面后 queued 任务应恢复调度，而非永久等待');
    await until(() => manager.runs.size === 0, '恢复下载应释放运行锁');
    assert.equal(images.size, 2);
    tasks.clear(); albums.clear(); chapters.clear(); images.clear();
  }

  if (!only || only === 'stale') {
    const manager = new DownloadManager();
    await manager.ready;
    const before = requests;
    lockHook = async () => {
      const task = [...tasks.values()][0];
      tasks.set(task.id, { ...task, status: 'completed', message: '另一标签已完成' });
    };
    const task = await manager.enqueueAlbum('42', { album: queuedTask().request.album, cacheCover: false });
    await until(() => manager.runs.size === 0, '旧任务应完成锁内状态核对');
    assert.equal(requests, before, '等待 aid 锁时别页已完成的任务不得再请求章节/图片');
    assert.equal((await manager.get(task.id)).status, 'completed');
    lockHook = null;
    tasks.clear(); albums.clear(); chapters.clear(); images.clear();
  }

  if (!only || only === 'removed') {
    const manager = new DownloadManager();
    await manager.ready;
    const before = requests;
    lockHook = async () => tasks.clear();
    const task = await manager.enqueueAlbum('42', { album: queuedTask().request.album, cacheCover: false });
    await until(() => manager.runs.size === 0, '已删除的旧任务应退出');
    assert.equal(requests, before, '等待锁时被删除的任务不得重新开始下载');
    assert.equal(tasks.has(task.id), false, '不得用旧镜像复活被删除的任务');
    assert.equal(await manager.get(task.id), null);
    lockHook = null;
    tasks.clear(); albums.clear(); chapters.clear(); images.clear();
  }

  if (!only || only === 'workers') {
    const manager = new DownloadManager();
    await manager.ready;
    const slowWrite = deferred();
    let secondWorkerStarted = false;
    imageHook = async (image) => {
      if (image.index === 0) {
        await until(() => secondWorkerStarted, '第二个 worker 应已经进入写入');
        const error = new Error('quota exhausted'); error.name = 'QuotaExceededError'; throw error;
      }
      secondWorkerStarted = true;
      await slowWrite.promise;
    };
    const task = await manager.enqueueAlbum('42', { album: queuedTask().request.album, cacheCover: false, concurrency: 2 });
    await until(() => secondWorkerStarted, '并行下载应开始');
    await turn(); await turn();
    const stillRunning = manager.runs.has(task.id);
    // 失败时也先释放测试桩，防止断言失败后留下永久运行的心跳。
    slowWrite.resolve();
    await until(() => manager.runs.size === 0, '全部 worker 停止后才应释放运行锁');
    assert.equal(stillRunning, true, '首个 worker 配额失败时必须等其他写入结束，不能提前释放清理锁');
    assert.equal(tasks.get(task.id).status, 'failed');
    assert.match(tasks.get(task.id).error, /存储空间不足/);
    imageHook = null;
  }
  console.log('download restoration/stale-lock/worker settlement all pass');
})().catch((error) => { console.error(error); process.exitCode = 1; });
