// ─── Lot Thumbnail ────────────────────────────────────────────────────────────
// Shared lazy-loaded image for lot cards. Renders lot.image when present,
// falls back to a neutral placeholder icon on missing/broken URLs.
//
// Perf: native lazy-loading + async decode so off-screen images never block
// the main thread during a big scroll. Fades in once loaded to avoid layout
// flash on a long grid.

import { memo, useState, useEffect } from 'react';
import { Package } from 'lucide-react';
import { getPipelineBase, getPipelineBaseSync } from '../../services/pipelineFetch';

// Module-cached pipeline base — resolved once per Hub session. The first
// LotThumbnail render kicks off the load; subsequent thumbnails reuse
// the cached value synchronously.
let _baseLoaded = false;
let _baseLoadPromise = null;

function ensureBase() {
  if (_baseLoaded) return Promise.resolve();
  if (!_baseLoadPromise) {
    _baseLoadPromise = getPipelineBase()
      .catch(() => {})
      .finally(() => { _baseLoaded = true; });
  }
  return _baseLoadPromise;
}

// Liquidation.com 403s hotlinked images — route them through the pipeline's
// image proxy. Data URLs and same-origin images load directly.
//
// The proxy route is deliberately unauthenticated: <img src> can't carry an
// Authorization header. What it will actually serve is up to the pipeline's
// configured lot provider — see noltech-pipeline/src/providers/.
function resolveSrc(src, base) {
  if (!src) return src;
  if (/^(data:|blob:)/i.test(src)) return src;
  if (!/^https?:\/\//i.test(src)) return src;
  return `${base}/lots/image?url=${encodeURIComponent(src)}`;
}

function LotThumbnailInner({ src: rawSrc, alt, className = '', iconSize = 28, fit = 'cover' }) {
  const [errored, setErrored] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    if (_baseLoaded) return;
    let alive = true;
    ensureBase().then(() => { if (alive) forceUpdate((n) => n + 1); });
    return () => { alive = false; };
  }, []);

  const src = resolveSrc(rawSrc, getPipelineBaseSync());

  if (!src || errored) {
    return (
      <div className={`flex items-center justify-center bg-muted/40 text-fg-subtle ${className}`}>
        <Package size={iconSize} className="opacity-30" />
      </div>
    );
  }

  const fitClass = fit === 'contain' ? 'object-contain' : 'object-cover';

  return (
    <div className={`relative overflow-hidden bg-muted/40 ${className}`}>
      {!loaded && (
        <div className="absolute inset-0 animate-pulse bg-muted/50" />
      )}
      <img
        src={src}
        alt={alt || 'Lot image'}
        loading="lazy"
        decoding="async"
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={`h-full w-full ${fitClass} transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
      />
    </div>
  );
}

const LotThumbnail = memo(LotThumbnailInner);
export default LotThumbnail;
