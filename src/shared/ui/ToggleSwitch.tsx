export interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  ariaLabel?: string;
  disabled?: boolean;
}

export function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
  disabled = false,
}: ToggleSwitchProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`group relative inline-flex h-[24px] w-[42px] shrink-0 items-center rounded-full transition-[background-color,box-shadow] duration-300 ease-[var(--motion-ease)] select-none border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-surface ${
        disabled
          ? "cursor-not-allowed opacity-40 " +
            (checked ? "bg-accent-primary/50" : "bg-bg-active")
          : "cursor-pointer " +
            (checked
              ? "bg-accent-primary shadow-[0_4px_12px_-4px_var(--accent-primary)]"
              : "bg-border-alpha-20 shadow-[inset_0_0_0_1px_var(--border-primary)] hover:bg-border-alpha-33")
      }`}
      aria-pressed={checked}
      aria-label={ariaLabel}
    >
      <span
        className={`inline-block h-[18px] w-[18px] rounded-full shadow-[0_2px_6px_rgba(0,0,0,0.28)] transition-transform duration-300 ease-[var(--motion-ease-emphasized)] ${
          checked
            ? "translate-x-[21px] bg-white"
            : "translate-x-[3px] bg-white"
        }`}
      />
    </button>
  );
}

export default ToggleSwitch;
