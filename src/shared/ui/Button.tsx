import { forwardRef } from "react";

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "ghost" | "secondary" | "outline" | "glass" | "glass-primary" | "glass-action";
  size?: "default" | "sm" | "lg" | "icon";
}

const focusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary";

const variantClasses: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary:
    `bg-btn-primary-bg text-btn-primary-text hover:brightness-[1.07] hover:-translate-y-[1px] active:translate-y-0 shadow-[0_10px_24px_-14px_var(--btn-primary-bg)] hover:shadow-[0_16px_32px_-14px_var(--btn-primary-bg)] ${focusClass}`,
  secondary:
    `bg-bg-elevated text-text-primary shadow-[inset_0_0_0_1px_var(--border-primary)] hover:bg-bg-surface hover:shadow-[inset_0_0_0_1px_var(--border-secondary)] ${focusClass}`,
  outline:
    `border border-border-secondary bg-transparent text-text-primary hover:border-accent-primary/50 hover:bg-accent-soft ${focusClass}`,
  ghost:
    `bg-transparent text-text-secondary hover:text-text-primary hover:bg-bg-hover border border-transparent ${focusClass}`,
  glass:
    `apple-glass-pill ${focusClass}`,
  "glass-primary":
    `apple-glass-prominent ${focusClass}`,
  "glass-action":
    `apple-glass-action ${focusClass}`,
};

const sizeClasses: Record<NonNullable<ButtonProps["size"]>, string> = {
  default: "h-[40px] px-[16px] text-[13.5px]",
  sm: "h-[32px] px-[12px] text-[12.5px]",
  lg: "h-[48px] px-[22px] text-[14.5px]",
  icon: "h-[40px] w-[40px]",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "default",
      className = "",
      children,
      ...rest
    },
    ref,
  ) => (
    <button
      ref={ref}
      className={`inline-flex items-center justify-center gap-[8px] rounded-full font-[550] tracking-[-0.008em] transition-[color,background-color,opacity,transform,box-shadow,border-color,filter] duration-200 ease-[var(--motion-ease)] active:scale-[0.97] motion-reduce:transition-none motion-reduce:active:scale-100 disabled:pointer-events-none disabled:opacity-45 cursor-pointer select-none ${
        variantClasses[variant]
      } ${sizeClasses[size]} ${className}`.trim()}
      style={{
        fontFamily: "var(--font-inter), sans-serif",
        letterSpacing: "0",
        lineHeight: "normal",
      }}
      {...rest}
    >
      {children}
    </button>
  ),
);

Button.displayName = "Button";

export default Button;
