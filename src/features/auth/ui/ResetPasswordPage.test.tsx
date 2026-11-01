import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";
import ResetPasswordPage from "./ResetPasswordPage";

const mockGetPasswordReset = vi.fn();
const mockCompletePasswordReset = vi.fn();
const mockNavigate = vi.fn();
let searchParams = new URLSearchParams();

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
  useSearchParams: () => [searchParams],
}));

vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: any) => <>{children}</>,
  motion: {
    div: ({ children, className, style, ...props }: any) => (
      <div className={className} style={style} {...props}>
        {children}
      </div>
    ),
    p: ({ children, className, style, ...props }: any) => (
      <p className={className} style={style} {...props}>
        {children}
      </p>
    ),
    form: ({ children, className, style, ...props }: any) => (
      <form className={className} style={style} {...props}>
        {children}
      </form>
    ),
  },
}));

vi.mock("@/shared/api", () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: {
    getPasswordReset: (...args: unknown[]) => mockGetPasswordReset(...args),
    completePasswordReset: (...args: unknown[]) =>
      mockCompletePasswordReset(...args),
  },
}));

vi.mock("../store/authStore", () => {
  const useAuthStore = (selector: any) =>
    selector({ status: "anonymous", user: null, logout: vi.fn() });
  useAuthStore.getState = () => ({ status: "anonymous" });
  return { useAuthStore };
});

vi.mock("@/languages", () => ({
  LOCALE_OPTIONS: [{ value: "en", label: "English" }],
  useTranslation: () => ({
    locale: "en",
    setLocale: vi.fn(),
    t: (key: string) => key,
  }),
}));

vi.mock("@/features/navigation/ui/WindowControls", () => ({
  default: () => null,
}));

vi.mock("@/features/navigation/hooks/useWindowState", () => ({
  useWindowState: () => ({ isEdgeToEdge: false }),
}));

vi.mock("@/shared/ui/CircleDitherCanvas", () => ({
  default: () => null,
}));

async function renderPage() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<ResetPasswordPage />);
  });
  return { container, root };
}

describe("ResetPasswordPage", () => {
  let roots: Root[] = [];
  const containers: HTMLDivElement[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    searchParams = new URLSearchParams();
    roots = [];
    containers.length = 0;
  });

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    for (const container of containers) {
      if (container.parentNode) container.parentNode.removeChild(container);
    }
  });

  it("rejects a malformed token without calling the api", async () => {
    searchParams = new URLSearchParams("token=lrst_short");
    const page = await renderPage();
    roots.push(page.root);
    containers.push(page.container);

    expect(page.container.textContent).toContain("reset_password.invalid_title");
    expect(mockGetPasswordReset).not.toHaveBeenCalled();
  });

  it("loads the masked account for a well-formed token", async () => {
    searchParams = new URLSearchParams(`token=lrst_${"a".repeat(43)}`);
    mockGetPasswordReset.mockResolvedValueOnce({
      maskedEmail: "a***e@example.com",
      expiresAt: new Date().toISOString(),
    });
    const page = await renderPage();
    roots.push(page.root);
    containers.push(page.container);

    expect(mockGetPasswordReset).toHaveBeenCalledWith(`lrst_${"a".repeat(43)}`);
    expect(page.container.textContent).toContain("a***e@example.com");
    expect(page.container.querySelector("#reset-password")).not.toBeNull();
  });

  it("refuses mismatched passwords and completes the reset", async () => {
    searchParams = new URLSearchParams(`token=lrst_${"b".repeat(43)}`);
    mockGetPasswordReset.mockResolvedValueOnce({
      maskedEmail: "b***b@example.com",
      expiresAt: new Date().toISOString(),
    });
    mockCompletePasswordReset.mockResolvedValueOnce({ success: true });
    const page = await renderPage();
    roots.push(page.root);
    containers.push(page.container);

    const password = page.container.querySelector(
      "#reset-password",
    ) as HTMLInputElement;
    const confirm = page.container.querySelector(
      "#reset-confirm",
    ) as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;

    await act(async () => {
      setValue.call(password, "newpassword123");
      password.dispatchEvent(new Event("input", { bubbles: true }));
      setValue.call(confirm, "different123");
      confirm.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const form = page.container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(page.container.textContent).toContain(
      "login.errors.password_mismatch",
    );
    expect(mockCompletePasswordReset).not.toHaveBeenCalled();

    await act(async () => {
      setValue.call(confirm, "newpassword123");
      confirm.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mockCompletePasswordReset).toHaveBeenCalledWith(
      `lrst_${"b".repeat(43)}`,
      "newpassword123",
    );
    expect(page.container.textContent).toContain("reset_password.done_title");
  });
});
