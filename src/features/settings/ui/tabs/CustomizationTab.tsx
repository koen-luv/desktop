import { useState, useRef, useCallback } from "react";
import {
  Gallery,
  TrashBin2,
  Refresh,
} from "@solar-icons/react";
import { Upload2Line, CopyLine, ArrowUpLine, ArrowDownLine } from "@mingcute/react";

import { useTranslation } from "@/languages";
import { Button, Slider, ToggleSwitch, useToast } from "@/shared/ui";
import {
  SettingBlock,
  SettingRow,
  SettingSection,
  SegmentedControl,
} from "../controls";
import {
  useCustomizationStore,
  MIN_OPACITY,
  MAX_OPACITY,
  MIN_BLUR,
  MAX_BLUR,
  MIN_DIM,
  MAX_DIM,
  PLAYER_ELEMENT_IDS,
  type PlayerElementId,
} from "../../store/customizationStore";

const font = { fontFamily: "var(--font-inter), sans-serif" } as const;

type BlockTarget = "sidebar" | "contentView" | "miniplayer";

export function CustomizationTab({ searchQuery }: { searchQuery?: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [activeBlock, setActiveBlock] = useState<BlockTarget>("contentView");
  const [isDragOver, setIsDragOver] = useState(false);

  const backgroundImage = useCustomizationStore((s) => s.backgroundImage);
  const backgroundBlur = useCustomizationStore((s) => s.backgroundBlur);
  const backgroundDim = useCustomizationStore((s) => s.backgroundDim);
  const backgroundOpacity = useCustomizationStore((s) => s.backgroundOpacity);
  const sidebar = useCustomizationStore((s) => s.sidebar);
  const contentView = useCustomizationStore((s) => s.contentView);
  const miniplayer = useCustomizationStore((s) => s.miniplayer);

  const setBackgroundImage = useCustomizationStore((s) => s.setBackgroundImage);
  const setBackgroundBlur = useCustomizationStore((s) => s.setBackgroundBlur);
  const setBackgroundDim = useCustomizationStore((s) => s.setBackgroundDim);
  const setBackgroundOpacity = useCustomizationStore((s) => s.setBackgroundOpacity);
  const setBlockConfig = useCustomizationStore((s) => s.setBlockConfig);
  const applyToAllBlocks = useCustomizationStore((s) => s.applyToAllBlocks);
  const resetBlock = useCustomizationStore((s) => s.resetBlock);
  const resetAll = useCustomizationStore((s) => s.resetAll);
  const playerElementOrder = useCustomizationStore((s) => s.playerElementOrder);
  const movePlayerElement = useCustomizationStore((s) => s.movePlayerElement);

  const playerElementLabels: Record<PlayerElementId, string> = {
    artwork: t("settings.customization.player_artwork") || "Album artwork",
    trackInfo: t("settings.customization.player_track_info") || "Track title & artist",
    timeline: t("settings.customization.player_timeline") || "Seek bar & times",
    controls: t("settings.customization.player_controls") || "Playback controls",
    volume: t("settings.customization.player_volume") || "Volume",
  };
  const orderedPlayerElements = playerElementOrder.length
    ? playerElementOrder
    : PLAYER_ELEMENT_IDS;

  const handleFileChange = useCallback(
    (file: File) => {
      if (!file.type.startsWith("image/")) {
        toast(t("settings.customization.invalid_file_type") || "Please select an image or GIF file", "error");
        return;
      }
      if (file.size > 30 * 1024 * 1024) {
        toast(t("settings.customization.file_too_large") || "File size must be under 30 MB", "error");
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        if (result) {
          setBackgroundImage(result);
          toast(t("settings.customization.applied") || "Wallpaper applied", "success");
        }
      };
      reader.onerror = () => {
        toast(t("settings.customization.read_error") || "Failed to read image file", "error");
      };
      reader.readAsDataURL(file);
    },
    [setBackgroundImage, toast, t],
  );

  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileChange(file);
    }
    e.target.value = "";
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleFileChange(file);
    }
  };

  const currentBlockConfig =
    activeBlock === "sidebar"
      ? sidebar
      : activeBlock === "contentView"
        ? contentView
        : miniplayer;

  return (
    <div className="flex flex-col gap-[16px]">
      <input
        id="liner-wallpaper-input"
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        // Keep the input in the layout instead of display:none: WebViews
        // (Android/iOS) refuse to open a file picker from a programmatic
        // click on a hidden input. It is visually hidden but still clickable
        // through the label below.
        className="sr-only"
        onChange={onFileInputChange}
      />

      {/* ── Background Wallpaper Section ── */}
      <SettingSection>
        <SettingBlock
          title={t("settings.customization.wallpaper_title") || "Window Wallpaper"}
          description={
            t("settings.customization.wallpaper_description") ||
            "Set a custom image or animated GIF as the full window background."
          }
          titleKey="settings.customization.wallpaper_title"
          descKey="settings.customization.wallpaper_description"
          searchQuery={searchQuery}
        >
          {backgroundImage ? (
            <div className="flex flex-col gap-[12px] rounded-xl border border-border-primary/60 bg-border-alpha-14 p-[12px]">
              <div className="relative h-[120px] w-full overflow-hidden rounded-lg bg-black/40">
                <img
                  src={backgroundImage}
                  alt="Window Background"
                  className="h-full w-full object-cover"
                  style={{
                    filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
                  }}
                />
                {backgroundDim > 0 && (
                  <div
                    className="absolute inset-0 bg-black pointer-events-none"
                    style={{ opacity: backgroundDim / 100 }}
                  />
                )}
                <div className="absolute right-[8px] top-[8px] flex items-center gap-[6px]">
                  <label
                    htmlFor="liner-wallpaper-input"
                    className="inline-flex h-[28px] items-center justify-center gap-[5px] rounded-md px-[10px] text-[12px] text-white bg-black/60 hover:bg-black/80 backdrop-blur-md cursor-pointer select-none"
                    aria-label={t("settings.customization.change_button") || "Change"}
                  >
                    <Upload2Line size={14} />
                    {t("settings.customization.change_button") || "Change"}
                  </label>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setBackgroundImage(null);
                      toast(t("settings.customization.removed") || "Wallpaper removed", "info");
                    }}
                    className="!h-[28px] !w-[28px] !p-0 bg-black/60 hover:bg-[#ff4d4d]/80 text-white backdrop-blur-md border-0"
                    title={t("settings.customization.remove_button") || "Remove"}
                    aria-label={t("settings.customization.remove_button") || "Remove"}
                  >
                    <TrashBin2 size={15} />
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-[16px] pt-[4px]">
                <div className="flex flex-col gap-[4px]">
                  <span className="text-text-secondary text-[12px]" style={font}>
                    {t("settings.customization.wallpaper_blur") || "Wallpaper blur"}
                  </span>
                  <Slider
                    value={backgroundBlur}
                    onChange={setBackgroundBlur}
                    min={0}
                    max={30}
                    unit="px"
                    ariaLabel={t("settings.customization.wallpaper_blur") || "Wallpaper blur"}
                  />
                </div>
                <div className="flex flex-col gap-[4px]">
                  <span className="text-text-secondary text-[12px]" style={font}>
                    {t("settings.customization.wallpaper_dim") || "Wallpaper dimming"}
                  </span>
                  <Slider
                    value={backgroundDim}
                    onChange={setBackgroundDim}
                    min={0}
                    max={80}
                    unit="%"
                    ariaLabel={t("settings.customization.wallpaper_dim") || "Wallpaper dimming"}
                  />
                </div>
                <div className="flex flex-col gap-[4px]">
                  <span className="text-text-secondary text-[12px]" style={font}>
                    {t("settings.customization.wallpaper_opacity") || "Wallpaper opacity"}
                  </span>
                  <Slider
                    value={backgroundOpacity}
                    onChange={setBackgroundOpacity}
                    min={MIN_OPACITY}
                    max={MAX_OPACITY}
                    unit="%"
                    ariaLabel={t("settings.customization.wallpaper_opacity") || "Wallpaper opacity"}
                  />
                </div>
              </div>
            </div>
          ) : (
            <label
              htmlFor="liner-wallpaper-input"
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragOver(true);
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
              className={`flex flex-col items-center justify-center gap-[8px] rounded-xl border border-dashed py-[24px] px-[16px] text-center cursor-pointer transition-colors ${
                isDragOver
                  ? "border-text-primary bg-border-alpha-20"
                  : "border-border-secondary hover:border-text-tertiary hover:bg-border-alpha-14"
              }`}
              style={{ padding: "8px" }}
            >
              <div className="flex h-[36px] w-[36px] items-center justify-center rounded-full bg-border-alpha-14 text-text-tertiary">
                <Gallery size={20} />
              </div>
              <div className="flex flex-col gap-[2px]">
                <span className="text-text-primary text-[13px] font-[500]" style={font}>
                  {t("settings.customization.upload_title") || "Select image or animated GIF"}
                </span>
                <span className="text-text-tertiary text-[11.5px]" style={font}>
                  {t("settings.customization.upload_hint") || "PNG, JPEG, GIF, WebP (up to 30MB)"}
                </span>
              </div>
            </label>
          )}
        </SettingBlock>
      </SettingSection>

      {/* ── 3 Logic Blocks Customization Section ── */}
      <SettingSection>
        <SettingBlock
          title={t("settings.customization.blocks_title") || "Blocks Glassmorphism"}
          description={
            t("settings.customization.blocks_description") ||
            "Adjust transparency, backdrop blur and dimming for each interface area."
          }
          titleKey="settings.customization.blocks_title"
          descKey="settings.customization.blocks_description"
          searchQuery={searchQuery}
        >
          <div className="flex flex-col gap-[14px]">
            {/* Block Target Selector */}
            {/* Stacks on phones: the 3 pill targets plus To all/Reset are wider
                than the dialog there and were spilling past the screen edge. */}
            <div className="flex flex-col items-start gap-[8px] sm:flex-row sm:items-center sm:justify-between">
              <SegmentedControl<BlockTarget>
                ariaLabel={t("settings.customization.blocks_title") || "Blocks Glassmorphism"}
                value={activeBlock}
                onChange={setActiveBlock}
                options={[
                  {
                    value: "sidebar",
                    label: t("settings.customization.block_sidebar") || "Sidebar",
                  },
                  {
                    value: "contentView",
                    label: t("settings.customization.block_content") || "Content View",
                  },
                  {
                    value: "miniplayer",
                    label: t("settings.customization.block_miniplayer") || "Miniplayer",
                  },
                ]}
              />

              <div className="flex items-center gap-[6px] shrink-0">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    applyToAllBlocks(activeBlock);
                    toast(t("settings.customization.applied_to_all") || "Settings applied to all blocks", "success");
                  }}
                  className="!h-[32px] !px-[10px] !gap-[5px] !text-[12px] whitespace-nowrap"
                  title={t("settings.customization.apply_all_title") || "Apply settings to all blocks"}
                >
                  <CopyLine size={14} />
                  {t("settings.customization.apply_all") || "To all"}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    resetBlock(activeBlock);
                    toast(t("settings.customization.block_reset") || "Block reset", "info");
                  }}
                  className="!h-[32px] !px-[10px] !gap-[5px] !text-[12px] whitespace-nowrap"
                  title={t("settings.customization.block_reset") || "Reset block"}
                >
                  <Refresh size={14} />
                  {t("settings.customization.reset_block") || "Reset"}
                </Button>
              </div>
            </div>

            {/* Block Sliders */}
            <div className="flex flex-col gap-[12px] rounded-xl border border-border-primary/60 bg-border-alpha-14 p-[14px]">
              {/* Opacity Slider */}
              <div className="flex flex-col items-start gap-[8px] sm:flex-row sm:items-center sm:justify-between sm:gap-[16px]">
                <div className="flex w-full min-w-0 max-w-[200px] flex-col gap-[2px] sm:w-auto">
                  <span className="text-text-primary text-[13px] font-[500]" style={font}>
                    {t("settings.customization.opacity") || "Opacity"}
                  </span>
                  <span className="text-text-tertiary text-[11.5px]" style={font}>
                    {t("settings.customization.opacity_desc") ||
                      "Background opacity (0% is fully transparent)"}
                  </span>
                </div>
                <div className="w-full shrink-0 sm:w-[190px]">
                  <Slider
                    value={currentBlockConfig.opacity}
                    onChange={(val) => setBlockConfig(activeBlock, { opacity: val })}
                    min={MIN_OPACITY}
                    max={MAX_OPACITY}
                    unit="%"
                    ariaLabel={t("settings.customization.opacity") || "Opacity"}
                  />
                </div>
              </div>

              {/* Backdrop Blur Slider */}
              <div className="flex flex-col items-start gap-[8px] sm:flex-row sm:items-center sm:justify-between sm:gap-[16px]">
                <div className="flex w-full min-w-0 max-w-[200px] flex-col gap-[2px] sm:w-auto">
                  <span className="text-text-primary text-[13px] font-[500]" style={font}>
                    {t("settings.customization.blur") || "Backdrop blur"}
                  </span>
                  <span className="text-text-tertiary text-[11.5px]" style={font}>
                    {t("settings.customization.blur_desc") || "Frosted glass blur intensity"}
                  </span>
                </div>
                <div className="w-full shrink-0 sm:w-[190px]">
                  <Slider
                    value={currentBlockConfig.blur}
                    onChange={(val) => setBlockConfig(activeBlock, { blur: val })}
                    min={MIN_BLUR}
                    max={MAX_BLUR}
                    unit="px"
                    ariaLabel={t("settings.customization.blur") || "Backdrop blur"}
                  />
                </div>
              </div>

              {/* Dimming Slider */}
              <div className="flex flex-col items-start gap-[8px] sm:flex-row sm:items-center sm:justify-between sm:gap-[16px]">
                <div className="flex w-full min-w-0 max-w-[200px] flex-col gap-[2px] sm:w-auto">
                  <span className="text-text-primary text-[13px] font-[500]" style={font}>
                    {t("settings.customization.dim") || "Dimming"}
                  </span>
                  <span className="text-text-tertiary text-[11.5px]" style={font}>
                    {t("settings.customization.dim_desc") || "Dark overlay for enhanced readability"}
                  </span>
                </div>
                <div className="w-full shrink-0 sm:w-[190px]">
                  <Slider
                    value={currentBlockConfig.dim}
                    onChange={(val) => setBlockConfig(activeBlock, { dim: val })}
                    min={MIN_DIM}
                    max={MAX_DIM}
                    unit="%"
                    ariaLabel={t("settings.customization.dim") || "Dimming"}
                  />
                </div>
              </div>
            </div>
          </div>
        </SettingBlock>

        <SettingBlock
          title={t("settings.customization.player_layout_title") || "Fullscreen player layout"}
          description={
            t("settings.customization.player_layout_description") ||
            "Reorder the elements shown around the artwork in fullscreen playback."
          }
          titleKey="settings.customization.player_layout_title"
          descKey="settings.customization.player_layout_description"
          searchQuery={searchQuery}
        >
          <div className="flex flex-col gap-[6px] rounded-xl border border-border-primary/60 bg-border-alpha-14 p-[10px]">
            {orderedPlayerElements.map((id, index) => (
              <div
                key={id}
                className="flex items-center justify-between gap-[10px] rounded-lg bg-bg-primary/40 px-[10px] py-[8px]"
              >
                <span className="min-w-0 truncate text-text-primary text-[12.5px]" style={font}>
                  {playerElementLabels[id]}
                </span>
                <div className="flex shrink-0 items-center gap-[2px]">
                  <button
                    type="button"
                    aria-label={`${t("settings.customization.move_up") || "Move up"}: ${playerElementLabels[id]}`}
                    disabled={index === 0}
                    onClick={() => movePlayerElement(id, -1)}
                    className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-text-tertiary transition-colors hover:bg-border-alpha-14 hover:text-text-primary disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUpLine size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`${t("settings.customization.move_down") || "Move down"}: ${playerElementLabels[id]}`}
                    disabled={index === orderedPlayerElements.length - 1}
                    onClick={() => movePlayerElement(id, 1)}
                    className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-md border-0 bg-transparent text-text-tertiary transition-colors hover:bg-border-alpha-14 hover:text-text-primary disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDownLine size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </SettingBlock>

        <SettingRow
          title={t("settings.customization.reset_all") || "Reset All Customization"}
          description={
            t("settings.customization.reset_all_desc") ||
            "Restore default appearance, clear background image and block glass effects."
          }
          titleKey="settings.customization.reset_all"
          descKey="settings.customization.reset_all_desc"
          searchQuery={searchQuery}
          control={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                resetAll();
                toast(t("settings.customization.all_reset") || "Customization reset", "info");
              }}
            >
              {t("settings.reset_defaults") || "Reset"}
            </Button>
          }
        />
      </SettingSection>
    </div>
  );
}
