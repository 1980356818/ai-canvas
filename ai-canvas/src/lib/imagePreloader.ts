const _loaded = new Set<string>();
const _pending = new Set<string>();
const _queued = new Set<string>();
const _queue: string[] = [];
const MAX_CONCURRENT = 6;

function drain() {
  while (_pending.size < MAX_CONCURRENT && _queue.length > 0) {
    const url = _queue.shift()!;
    _queued.delete(url);
    if (_loaded.has(url) || _pending.has(url)) continue;
    _pending.add(url);
    const img = new Image();
    img.decoding = "async";
    const done = () => {
      _pending.delete(url);
      _loaded.add(url);
      drain();
    };
    img.onload = done;
    img.onerror = done;
    img.src = url;
  }
}

export function preloadImages(urls: string[]) {
  let added = false;
  for (const url of urls) {
    if (!url || _loaded.has(url) || _pending.has(url) || _queued.has(url)) continue;
    _queue.push(url);
    _queued.add(url);
    added = true;
  }
  if (added) drain();
}

export function isPreloaded(url: string): boolean {
  return _loaded.has(url);
}
