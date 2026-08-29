// Tiny classname concat util — no clsx dependency
export function cn(...classes) {
  return classes.filter(Boolean).join(' ');
}
