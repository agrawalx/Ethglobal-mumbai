/** Arkiv listings expire 120 s after the last renewal (spec §11.2). The ring shows the time left. */
const LISTING_TTL_MS = 120_000;

export default function ExpiryRing({ expiresAt, now }: { expiresAt: number; now: number }) {
  if (!expiresAt) return <span className="faint" title="Expiry timestamp is not exposed by the gateway">expiry unavailable</span>;
  const left = Math.max(0, expiresAt - now);
  const frac = Math.min(1, left / LISTING_TTL_MS);
  const C = 2 * Math.PI * 14;
  const s = Math.round(left / 1000);
  return (
    <svg className="expiry-ring" viewBox="0 0 36 36" role="img" aria-label={`Listing expires in ${s} seconds unless renewed`}>
      <circle cx="18" cy="18" r="14" />
      <circle cx="18" cy="18" r="14" className="expiry-ring-fill" strokeDasharray={`${C * frac} ${C}`} />
      <text x="18" y="21" textAnchor="middle">
        {s}
      </text>
    </svg>
  );
}
