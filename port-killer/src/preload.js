contextBridge.exposeInMainWorld('api', {
  listPorts: () => __bunmaska.invoke('ports:list'),
  kill: (pid, force = false) => __bunmaska.invoke('ports:kill', pid, force),
  killCommand: (pid, force = false) =>
    __bunmaska.invoke('ports:killCommand', pid, force),
  platform: () => __bunmaska.invoke('app:platform'),
  quit: () => __bunmaska.invoke('app:quit'),
  onRefresh: (cb) => {
    __bunmaska.on('ports:refresh', cb);
  },
});

