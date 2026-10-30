import React, { useId } from "react";
import { motion } from "framer-motion";

export interface TabItem<T extends string = string> {
  id: T;
  label: React.ReactNode;
  icon?: React.ReactNode;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export interface PillTabsProps<T extends string = string> {
  tabs: (TabItem<T> | T)[];
  activeTab: T;
  onChange: (tab: T) => void;
  layoutId?: string;
  variant?: "solid" | "glass" | "expressive";
  size?: "sm" | "md" | "lg";
  className?: string;
  tabClassName?: string;
}

export function PillTabs<T extends string = string>({
  tabs,
  activeTab,
  onChange,
  layoutId: customLayoutId,
  variant = "expressive",
  size = "md",
  className = "",
  tabClassName = "",
}: PillTabsProps<T>) {
  const autoLayoutId = useId();
  const layoutId = customLayoutId || `pill-tabs-${autoLayoutId}`;

  const normalizedTabs: TabItem<T>[] = tabs.map((tab) =>
    typeof tab === "string" ? { id: tab as T, label: tab } : tab,
  );

  const sizeStyles = {
    sm: "h-[27px] px-[12px] text-[11.5px] gap-[6px] rounded-full",
    md: "h-[32px] px-[15px] text-[12.5px] gap-[7px] rounded-full",
    lg: "h-[38px] px-[19px] text-[13.5px] gap-[8px] rounded-full",
  }[size];

  const containerPadding = size === "sm" ? "p-[3px] gap-[2px]" : "p-[3px] gap-[3px]";

  const containerStyles =
    variant === "glass"
      ? "bg-black/25 dark:bg-white/[0.06] backdrop-blur-xl shadow-[inset_0_0_0_1px_rgba(255,255,255,0.10)]"
      : variant === "expressive"
        ? "bg-bg-panel/80 backdrop-blur-md shadow-[inset_0_0_0_1px_var(--border-primary)]"
        : "bg-bg-elevated shadow-[inset_0_0_0_1px_var(--border-primary)]";

  return (
    <div
      role="tablist"
      className={`inline-flex items-center rounded-full select-none ${containerPadding} ${containerStyles} ${className}`}
    >
      {normalizedTabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const isDisabled = tab.disabled;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            aria-disabled={isDisabled}
            disabled={isDisabled}
            type="button"
            onClick={() => !isDisabled && onChange(tab.id)}
            className={`relative inline-flex items-center justify-center font-[500] leading-none tracking-[-0.006em] transition-colors duration-200 border-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/70 focus-visible:ring-offset-1 focus-visible:ring-offset-bg-panel cursor-pointer ${
              isDisabled ? "opacity-40 cursor-not-allowed" : "active:scale-[0.975]"
            } ${sizeStyles} ${
              isActive
                ? "text-btn-primary-text"
                : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
            } ${tabClassName}`}
          >
            {isActive && (
              <motion.div
                layoutId={layoutId}
                className="absolute inset-0 rounded-[inherit] bg-btn-primary-bg shadow-e1 shadow-[0_6px_16px_-8px_var(--btn-primary-bg)]"
                transition={{
                  type: "spring",
                  stiffness: 450,
                  damping: 32,
                  mass: 0.8,
                }}
              />
            )}

            <span className="relative z-10 flex items-center gap-[6px]">
              {tab.icon && <span className="shrink-0">{tab.icon}</span>}
              <span>{tab.label}</span>
              {tab.badge && <span className="shrink-0">{tab.badge}</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export default PillTabs;
