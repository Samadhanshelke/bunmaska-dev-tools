contextBridge.exposeInMainWorld('api', {
  pickRepo: () => __bunmaska.invoke('repo:pick'),
  recentRepo: () => __bunmaska.invoke('repo:recent'),
  scan: (path) => __bunmaska.invoke('repo:scan', path),
  copy: (text) => __bunmaska.invoke('clipboard:write', text),
  platform: () => __bunmaska.invoke('app:platform'),
  quit: () => __bunmaska.invoke('app:quit'),
  onRefresh: (cb) => {
    __bunmaska.on('repo:refresh', cb);
  },
});
