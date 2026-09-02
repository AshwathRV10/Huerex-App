/**
 * Icons, drawn inline.
 *
 * No icon font and no icon package: one less thing to fetch, one less thing
 * that can go missing on a machine with no internet, and they inherit colour
 * and stroke weight from the text beside them.
 */

type P = { size?: number; className?: string };

const base = (size: number, className?: string) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, className, 'aria-hidden': true,
});

export const Icon = {
  Dashboard: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
  ),
  Order: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" /><path d="M9 8h6M9 12h6M9 16h3" /></svg>
  ),
  Route: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="6" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M6 8.5v5a4 4 0 0 0 4 4h5.5" /></svg>
  ),
  Grid: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M9 3v18M15 3v18" /></svg>
  ),
  Fabric: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M3 7c2 0 2 2 4.5 2S10 7 12 7s2 2 4.5 2S19 7 21 7" /><path d="M3 12c2 0 2 2 4.5 2S10 12 12 12s2 2 4.5 2S19 12 21 12" /><path d="M3 17c2 0 2 2 4.5 2S10 17 12 17s2 2 4.5 2S19 17 21 17" /></svg>
  ),
  Trim: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8 8l12 8M8 16 20 8" /></svg>
  ),
  Scissors: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><path d="M8 8l12 8M8 16 20 8M14 12 8 8" /></svg>
  ),
  Vendor: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M3 9 5 4h14l2 5" /><path d="M4 9h16v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9Z" /><path d="M9 20v-6h6v6" /></svg>
  ),
  Needle: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M4 20 20 4" /><path d="M14 4h6v6" /><circle cx="7" cy="17" r="2" /></svg>
  ),
  Check: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="m4 12 5 5L20 6" /></svg>
  ),
  Shield: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></svg>
  ),
  Box: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M21 8 12 3 3 8l9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>
  ),
  Truck: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M3 6h11v10H3z" /><path d="M14 9h4l3 3v4h-7z" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></svg>
  ),
  Layers: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 13 9 5 9-5" /></svg>
  ),
  Scale: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M12 4v16M7 20h10" /><path d="m4 10 3-5 3 5a3 3 0 0 1-6 0Z" /><path d="m14 10 3-5 3 5a3 3 0 0 1-6 0Z" /></svg>
  ),
  Clock: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
  ),
  Bell: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M18 15V10a6 6 0 1 0-12 0v5l-2 3h16l-2-3Z" /><path d="M10 21h4" /></svg>
  ),
  Alert: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M12 4 2.5 20h19L12 4Z" /><path d="M12 10v4M12 17.5v.01" /></svg>
  ),
  Rupee: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M7 4h10M7 9h10M15.5 4c0 3.5-2.5 5-6 5h-2l8 11" /></svg>
  ),
  Tag: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M3 12V5a2 2 0 0 1 2-2h7l9 9-9 9-9-9Z" /><circle cx="8" cy="8" r="1.4" /></svg>
  ),
  Users: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="9" cy="8" r="3.2" /><path d="M3 20a6 6 0 0 1 12 0" /><path d="M16 5.5a3.2 3.2 0 0 1 0 6M17.5 20a6 6 0 0 0-2-4.5" /></svg>
  ),
  Book: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2V5Z" /><path d="M8 3v18" /></svg>
  ),
  Settings: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M22 12h-3M5 12H2M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6" /></svg>
  ),
  Search: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  ),
  Menu: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M4 7h16M4 12h16M4 17h16" /></svg>
  ),
  Chevron: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="m9 6 6 6-6 6" /></svg>
  ),
  Plus: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M12 5v14M5 12h14" /></svg>
  ),
  Download: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M12 3v12M7 11l5 5 5-5" /><path d="M4 20h16" /></svg>
  ),
  Sun: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M22 12h-2M4 12H2M18.4 5.6l-1.4 1.4M7 17l-1.4 1.4M18.4 18.4 17 17M7 7 5.6 5.6" /></svg>
  ),
  Moon: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" /></svg>
  ),
  Logout: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 8 6 12l4 4M6 12h11" /></svg>
  ),
  Balance: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M3 20h18" /><rect x="4" y="11" width="4" height="9" rx="1" /><rect x="10" y="6" width="4" height="14" rx="1" /><rect x="16" y="14" width="4" height="6" rx="1" /></svg>
  ),
  Refresh: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 4v5h-5" /></svg>
  ),
  Copy: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></svg>
  ),
  Trash: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><path d="M4 7h16M10 4h4a1 1 0 0 1 1 1v2H9V5a1 1 0 0 1 1-1Z" /><path d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7" /><path d="M10 11v6M14 11v6" /></svg>
  ),
  Lock: ({ size = 18, className }: P) => (
    <svg {...base(size, className)}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>
  ),
};

export type IconName = keyof typeof Icon;
