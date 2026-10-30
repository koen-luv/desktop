import { forwardRef } from "react";

export interface TextInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  icon?: React.ReactNode;
  rightSlot?: React.ReactNode;
  size?: "default" | "sm";
  variant?: "default" | "transparent";
  hasError?: boolean;
}

const sizeClasses: Record<NonNullable<TextInputProps["size"]>, string> = {
  default: "h-[42px] px-[13px] text-[13.5px]",
  sm: "h-[34px] px-[11px] text-[12.5px]",
};

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  (
    {
      icon,
      rightSlot,
      size = "default",
      variant = "default",
      hasError = false,
      className = "",
      disabled,
      ...props
    },
    ref,
  ) => {
    const isTransparent = variant === "transparent";
    const bgClass =
      className.includes("bg-")
        ? ""
        : isTransparent
          ? "bg-transparent"
          : "bg-bg-elevated";

    const borderClass = hasError
      ? "border-accent-primary ring-1 ring-accent-primary/40"
      : isTransparent
        ? "border-transparent hover:border-border-secondary focus-within:border-accent-primary/60"
        : "border-border-primary hover:border-border-secondary focus-within:border-accent-primary/70 focus-within:ring-4 focus-within:ring-accent-soft focus-within:bg-bg-surface";

    return (
      <div
        className={`group flex items-center gap-[9px] rounded-xl border ${bgClass} ${borderClass} transition-[border-color,box-shadow,background-color,transform] duration-200 ease-[var(--motion-ease)] ${disabled ? "opacity-50 pointer-events-none" : ""} ${sizeClasses[size]} ${className}`.trim()}
      >
      {icon && (
        <span className="shrink-0 text-text-tertiary transition-colors duration-150 group-focus-within:text-text-secondary">
          {icon}
        </span>
      )}
      <input
        ref={ref}
        disabled={disabled}
        className="w-full bg-transparent border-none p-0 text-[inherit] font-[400] tracking-[-0.006em] text-text-primary placeholder:text-text-tertiary outline-none disabled:cursor-not-allowed [&::-ms-reveal]:hidden [&::-ms-clear]:hidden [&:-webkit-autofill]:shadow-[0_0_0_1000px_var(--bg-elevated)_inset] [&:-webkit-autofill]:[-webkit-text-fill-color:var(--text-primary)]"
        style={{
          fontFamily: "var(--font-inter), sans-serif",
          letterSpacing: "0",
          lineHeight: "normal",
        }}
        {...props}
      />
      {rightSlot && (
        <div className="shrink-0 flex items-center">{rightSlot}</div>
      )}
      </div>
    );
  },
);

TextInput.displayName = "TextInput";

export default TextInput;
