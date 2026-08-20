/**
 * Pragati Solutions' mark: a message bubble with a medical cross knocked out of
 * it — the two things MediBook is (a WhatsApp thread, and a clinic).
 *
 * Inline SVG rather than an <img>: it is drawn at every size from the 20px
 * sidebar to the 56px login tile, it must stay crisp on a retina screen, and
 * an <img> here would be one more request on the login page's critical path.
 *
 * `bubble`/`cross` are the only two colours the mark ever has — see the brand
 * rules; never tint the cross, or the counter drops below the contrast a
 * favicon-sized rendering needs.
 */
export default function BrandMark({
  className = 'w-8 h-8',
  bubble = '#014263',
  cross = '#ffffff',
  title = 'Pragati Solutions',
}) {
  return (
    <svg viewBox="0 0 100 100" className={className} role="img" aria-label={title}>
      <path
        d="M20 6h60a14 14 0 0 1 14 14v42a14 14 0 0 1-14 14H50L26 96V76h-6A14 14 0 0 1 6 62V20A14 14 0 0 1 20 6Z"
        fill={bubble}
      />
      <rect x="42" y="19" width="16" height="44" rx="4" fill={cross} />
      <rect x="28" y="33" width="44" height="16" rx="4" fill={cross} />
    </svg>
  );
}
