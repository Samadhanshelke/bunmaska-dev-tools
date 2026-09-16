contextBridge.exposeInMainWorld('api', {
  // Ports
  listPorts: () => __bunmaska.invoke('ports:list'),
  kill: (pid, force = false) => __bunmaska.invoke('ports:kill', pid, force),
  killCommand: (pid, force = false) =>
    __bunmaska.invoke('ports:killCommand', pid, force),
  onPortsRefresh: (cb) => {
    __bunmaska.on('ports:refresh', cb);
  },

  // Commits
  pickRepo: () => __bunmaska.invoke('repo:pick'),
  recentRepo: () => __bunmaska.invoke('repo:recent'),
  scan: (path) => __bunmaska.invoke('repo:scan', path),
  copy: (text) => __bunmaska.invoke('clipboard:write', text),
  readClipboard: () => __bunmaska.invoke('clipboard:read'),
  onRepoRefresh: (cb) => {
    __bunmaska.on('repo:refresh', cb);
  },

  // App shell
  platform: () => __bunmaska.invoke('app:platform'),
  prefs: () => __bunmaska.invoke('app:prefs'),
  setTool: (tool) => __bunmaska.invoke('app:setTool', tool),
  setGroqKey: (key) => __bunmaska.invoke('app:setGroqKey', key),
  clearGroqKey: () => __bunmaska.invoke('app:clearGroqKey'),
  quit: () => __bunmaska.invoke('app:quit'),
  onNavigate: (cb) => {
    __bunmaska.on('app:navigate', cb);
  },
});
