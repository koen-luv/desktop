import {
  useCustomizationStore,
  selectIsGlassThemeActive,
} from "../store/customizationStore";

// Glass surfaces are theme-aware (see getBlockStyle), so a wallpaper now works
// in both light and dark theme without forcing a switch. Exposes whether glass
// is currently active for any interested callers.
export function useThemeCustomizationSync() {
  const isGlassActive = useCustomizationStore(selectIsGlassThemeActive);
  return { isGlassActive };
}
