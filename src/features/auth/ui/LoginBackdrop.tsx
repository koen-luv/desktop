import cloudsBanner from "@/assets/wallhaven-5g1yz8.jpg";
import CircleDitherCanvas from "@/shared/ui/CircleDitherCanvas";
import { cn } from "@/shared/utils/cn";

export interface LoginBackdropProps {
  edgeToEdge?: boolean;
}

// keeps the existing dithered cloud art used across the app's empty surfaces
export function LoginBackdrop({ edgeToEdge = false }: LoginBackdropProps) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 z-0 select-none overflow-hidden",
        edgeToEdge ? "rounded-none" : "rounded-5xl",
      )}
    >
      <CircleDitherCanvas
        src={cloudsBanner}
        alt=""
        dotSize={7}
        gap={0.5}
        edgePadding={1.5}
        cornerRadius={12}
        gridType="square"
        objectFit="cover"
        className={cn("h-full w-full overflow-hidden", !edgeToEdge && "rounded-5xl")}
      />
    </div>
  );
}

export default LoginBackdrop;
