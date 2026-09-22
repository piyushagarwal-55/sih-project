export function Logo({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
        <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-ink-600" />
        <path d="M3.5 16C7 9.5 11.3 6.5 16 6.5S25 9.5 28.5 16C25 22.5 20.7 25.5 16 25.5S7 22.5 3.5 16Z" fill="#e2472a" />
        <circle cx="16" cy="16" r="5" fill="#070a10" />
        <circle cx="17.6" cy="14.4" r="1.6" fill="#fff" />
      </svg>
      <div className="leading-none">
        <div className="text-[15px] font-semibold tracking-tight">Divya Drishti</div>
        <div className="mt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-ink-400">Live camera network</div>
      </div>
    </div>
  );
}
