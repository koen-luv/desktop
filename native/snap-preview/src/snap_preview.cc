// Liner snap preview (windows).
//
// The drag-to-top "maximize" preview, done the way windows' own snap preview is:
// a popup window whose content is a Windows.UI.Composition visual tree that lives in
// DWM. The blur is a HostBackdropBrush (DWM's live blur of everything behind the
// window) and the growing / collapsing box is a rounded clip driven by expression
// animations over a property set. Keyframe animations run in the compositor at the
// display refresh rate, so the app does no per-frame work at all: JS only says
// "animate from A to B" (and, while collapsing, updates B as the window moves).
//
// Exposed (all coordinates in physical pixels; rects are [left, top, right, bottom]
// relative to the preview window, which covers one display's work area):
//   init() -> bool                 create window + compositor (false: unsupported)
//   hasBackdrop() -> bool          live blur available (windows 11)
//   setArea(x, y, w, h)            place / size the window (only while hidden)
//   setStyle(argbTint, radiusPx)
//   show(afterHwndBuffer | null)   show without activating, just below that window
//   hide()
//   animate(from, to, ms, [x1, y1, x2, y2])   cubic-bezier easing
//   setTarget(to)                  move the end of a running animation (live follow)
//   destroy()

// composition interop needs windows 8+ declarations (node-gyp defaults lower)
#ifdef _WIN32_WINNT
#undef _WIN32_WINNT
#endif
#define _WIN32_WINNT 0x0A00

#include <windows.h>
#include <dwmapi.h>
#include <unknwn.h>
#include <DispatcherQueue.h>
#include <windows.ui.composition.interop.h>

#include <winrt/base.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.Foundation.Numerics.h>
#include <winrt/Windows.System.h>
#include <winrt/Windows.UI.h>
#include <winrt/Windows.UI.Composition.h>
#include <winrt/Windows.UI.Composition.Desktop.h>

#include <node_api.h>

#include <chrono>
#include <cstdint>
#include <cstring>

namespace wuc = winrt::Windows::UI::Composition;
namespace wucd = winrt::Windows::UI::Composition::Desktop;
using winrt::Windows::Foundation::Numerics::float2;

#ifndef DWMWA_USE_HOSTBACKDROPBRUSH
#define DWMWA_USE_HOSTBACKDROPBRUSH 17
#endif
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif

namespace {

struct State {
  HWND hwnd = nullptr;
  winrt::Windows::System::DispatcherQueueController queue{nullptr};
  wuc::Compositor compositor{nullptr};
  wucd::DesktopWindowTarget target{nullptr};
  wuc::ContainerVisual root{nullptr};
  wuc::ContainerVisual box{nullptr};
  wuc::SpriteVisual backdrop{nullptr};
  wuc::SpriteVisual tintVisual{nullptr};
  wuc::CompositionColorBrush tint{nullptr};
  wuc::CompositionPropertySet props{nullptr};
  wuc::RectangleClip roundClip{nullptr};
  wuc::InsetClip insetClip{nullptr};
  bool hasBackdrop = false;
};

State g;

LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_NCHITTEST:
      return HTTRANSPARENT;  // never takes the mouse
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATE;
    case WM_ERASEBKGND:
      return 1;
    default:
      return DefWindowProcW(hwnd, msg, wp, lp);
  }
}

bool EnsureDispatcherQueue() {
  if (winrt::Windows::System::DispatcherQueue::GetForCurrentThread()) return true;
  DispatcherQueueOptions options{sizeof(DispatcherQueueOptions), DQTYPE_THREAD_CURRENT, DQTAT_COM_NONE};
  winrt::Windows::System::DispatcherQueueController controller{nullptr};
  HRESULT hr = CreateDispatcherQueueController(
      options, reinterpret_cast<ABI::Windows::System::IDispatcherQueueController**>(winrt::put_abi(controller)));
  if (FAILED(hr)) return false;
  g.queue = controller;
  return true;
}

void BindClipExpressions() {
  auto bind = [&](wuc::CompositionObject const& clip, wchar_t const* property, wchar_t const* expression) {
    auto expr = g.compositor.CreateExpressionAnimation(expression);
    expr.SetReferenceParameter(L"p", g.props);
    clip.StartAnimation(property, expr);
  };
  if (g.roundClip) {
    bind(g.roundClip, L"Left", L"Lerp(p.FL, p.TL, p.P)");
    bind(g.roundClip, L"Top", L"Lerp(p.FT, p.TT, p.P)");
    bind(g.roundClip, L"Right", L"Lerp(p.FR, p.TR, p.P)");
    bind(g.roundClip, L"Bottom", L"Lerp(p.FB, p.TB, p.P)");
  } else {
    bind(g.insetClip, L"LeftInset", L"Lerp(p.FL, p.TL, p.P)");
    bind(g.insetClip, L"TopInset", L"Lerp(p.FT, p.TT, p.P)");
    bind(g.insetClip, L"RightInset", L"p.W - Lerp(p.FR, p.TR, p.P)");
    bind(g.insetClip, L"BottomInset", L"p.H - Lerp(p.FB, p.TB, p.P)");
  }
}

bool Init() {
  if (g.hwnd) return true;
  try {
    if (!EnsureDispatcherQueue()) return false;

    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.lpfnWndProc = WndProc;
    wc.hInstance = instance;
    wc.lpszClassName = L"LinerSnapPreview";
    RegisterClassExW(&wc);  // fails harmlessly if already registered

    g.hwnd = CreateWindowExW(WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE, wc.lpszClassName,
                             L"", WS_POPUP, 0, 0, 1, 1, nullptr, nullptr, instance, nullptr);
    if (!g.hwnd) return false;

    BOOL on = TRUE;
    // live blur of what is behind the window (windows 11); fails on windows 10
    g.hasBackdrop = SUCCEEDED(DwmSetWindowAttribute(g.hwnd, DWMWA_USE_HOSTBACKDROPBRUSH, &on, sizeof(on)));
    // we animate ourselves; no dwm show / hide fades, no system corner rounding
    DwmSetWindowAttribute(g.hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, &on, sizeof(on));
    int noRound = 1;  // DWMWCP_DONOTROUND
    DwmSetWindowAttribute(g.hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, &noRound, sizeof(noRound));

    g.compositor = wuc::Compositor();
    auto interop = g.compositor.as<ABI::Windows::UI::Composition::Desktop::ICompositorDesktopInterop>();
    wucd::DesktopWindowTarget target{nullptr};
    winrt::check_hresult(interop->CreateDesktopWindowTarget(
        g.hwnd, TRUE,
        reinterpret_cast<ABI::Windows::UI::Composition::Desktop::IDesktopWindowTarget**>(winrt::put_abi(target))));
    g.target = target;

    g.root = g.compositor.CreateContainerVisual();
    g.root.RelativeSizeAdjustment(float2{1.f, 1.f});
    g.target.Root(g.root);

    g.box = g.compositor.CreateContainerVisual();
    g.box.RelativeSizeAdjustment(float2{1.f, 1.f});
    g.root.Children().InsertAtTop(g.box);

    if (g.hasBackdrop) {
      g.backdrop = g.compositor.CreateSpriteVisual();
      g.backdrop.RelativeSizeAdjustment(float2{1.f, 1.f});
      g.backdrop.Brush(g.compositor.CreateHostBackdropBrush());
      g.box.Children().InsertAtTop(g.backdrop);
    }
    g.tint = g.compositor.CreateColorBrush(winrt::Windows::UI::Color{0x29, 0x80, 0x80, 0x80});
    g.tintVisual = g.compositor.CreateSpriteVisual();
    g.tintVisual.RelativeSizeAdjustment(float2{1.f, 1.f});
    g.tintVisual.Brush(g.tint);
    g.box.Children().InsertAtTop(g.tintVisual);

    g.props = g.compositor.CreatePropertySet();
    for (wchar_t const* key : {L"FL", L"FT", L"FR", L"FB", L"TL", L"TT", L"TR", L"TB", L"P", L"W", L"H"}) {
      g.props.InsertScalar(key, 0.f);
    }

    // rounded clip needs windows 10 2004+; older builds get square corners
    try {
      g.roundClip = g.compositor.CreateRectangleClip();
      g.box.Clip(g.roundClip);
    } catch (...) {
      g.roundClip = nullptr;
      g.insetClip = g.compositor.CreateInsetClip();
      g.box.Clip(g.insetClip);
    }
    BindClipExpressions();  // all zero: an empty box
    return true;
  } catch (...) {
    if (g.hwnd) DestroyWindow(g.hwnd);
    g = State{};
    return false;
  }
}

void Destroy() {
  try {
    if (g.target) g.target.Root(nullptr);
  } catch (...) {
  }
  if (g.hwnd) DestroyWindow(g.hwnd);
  auto queue = g.queue;
  g = State{};
  g.queue = queue;  // the thread's dispatcher queue stays for a later init()
}

void SetEdges(wchar_t const* prefix, float const* r) {
  wchar_t key[3] = {prefix[0], 0, 0};
  static wchar_t const edges[4] = {L'L', L'T', L'R', L'B'};
  for (int i = 0; i < 4; ++i) {
    key[1] = edges[i];
    g.props.InsertScalar(key, r[i]);
  }
}

// ---------- n-api glue ----------

bool ReadRect(napi_env env, napi_value value, float* out) {
  bool isArray = false;
  if (napi_is_array(env, value, &isArray) != napi_ok || !isArray) return false;
  for (uint32_t i = 0; i < 4; ++i) {
    napi_value item;
    double d = 0;
    if (napi_get_element(env, value, i, &item) != napi_ok || napi_get_value_double(env, item, &d) != napi_ok) {
      return false;
    }
    out[i] = static_cast<float>(d);
  }
  return true;
}

double ArgNumber(napi_env env, napi_value value, double fallback = 0) {
  double d = fallback;
  napi_get_value_double(env, value, &d);
  return d;
}

napi_value Bool(napi_env env, bool v) {
  napi_value out;
  napi_get_boolean(env, v, &out);
  return out;
}

napi_value Undefined(napi_env env) {
  napi_value out;
  napi_get_undefined(env, &out);
  return out;
}

template <size_t N>
bool Args(napi_env env, napi_callback_info info, napi_value (&argv)[N], size_t& argc) {
  argc = N;
  return napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) == napi_ok;
}

napi_value JsInit(napi_env env, napi_callback_info) { return Bool(env, Init()); }

napi_value JsHasBackdrop(napi_env env, napi_callback_info) { return Bool(env, g.hasBackdrop); }

napi_value JsSetArea(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc;
  if (!g.hwnd || !Args(env, info, argv, argc) || argc < 4) return Undefined(env);
  int x = static_cast<int>(ArgNumber(env, argv[0]));
  int y = static_cast<int>(ArgNumber(env, argv[1]));
  int w = static_cast<int>(ArgNumber(env, argv[2], 1));
  int h = static_cast<int>(ArgNumber(env, argv[3], 1));
  SetWindowPos(g.hwnd, nullptr, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER);
  try {
    g.props.InsertScalar(L"W", static_cast<float>(w));
    g.props.InsertScalar(L"H", static_cast<float>(h));
  } catch (...) {
  }
  return Undefined(env);
}

napi_value JsSetStyle(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  size_t argc;
  if (!g.hwnd || !Args(env, info, argv, argc) || argc < 2) return Undefined(env);
  uint32_t argb = static_cast<uint32_t>(ArgNumber(env, argv[0]));
  float radius = static_cast<float>(ArgNumber(env, argv[1]));
  try {
    g.tint.Color(winrt::Windows::UI::Color{static_cast<uint8_t>(argb >> 24), static_cast<uint8_t>(argb >> 16),
                                           static_cast<uint8_t>(argb >> 8), static_cast<uint8_t>(argb)});
    if (g.roundClip) {
      float2 r{radius, radius};
      g.roundClip.TopLeftRadius(r);
      g.roundClip.TopRightRadius(r);
      g.roundClip.BottomLeftRadius(r);
      g.roundClip.BottomRightRadius(r);
    }
  } catch (...) {
  }
  return Undefined(env);
}

napi_value JsShow(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc;
  if (!g.hwnd || !Args(env, info, argv, argc)) return Undefined(env);
  HWND after = HWND_TOP;
  bool isBuffer = false;
  if (argc >= 1 && napi_is_buffer(env, argv[0], &isBuffer) == napi_ok && isBuffer) {
    void* data = nullptr;
    size_t length = 0;
    if (napi_get_buffer_info(env, argv[0], &data, &length) == napi_ok && length >= sizeof(HWND)) {
      std::memcpy(&after, data, sizeof(HWND));  // just below our app window
    }
  }
  SetWindowPos(g.hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
  return Undefined(env);
}

napi_value JsHide(napi_env env, napi_callback_info) {
  if (g.hwnd) ShowWindow(g.hwnd, SW_HIDE);
  return Undefined(env);
}

napi_value JsAnimate(napi_env env, napi_callback_info info) {
  napi_value argv[4];
  size_t argc;
  float from[4], to[4], bezier[4] = {0.33f, 1.f, 0.68f, 1.f};
  if (!g.hwnd || !Args(env, info, argv, argc) || argc < 3) return Undefined(env);
  if (!ReadRect(env, argv[0], from) || !ReadRect(env, argv[1], to)) return Undefined(env);
  double ms = ArgNumber(env, argv[2], 0);
  if (argc >= 4) ReadRect(env, argv[3], bezier);
  try {
    g.props.StopAnimation(L"P");
    SetEdges(L"F", from);
    SetEdges(L"T", to);
    if (ms <= 0) {
      g.props.InsertScalar(L"P", 1.f);
      return Undefined(env);
    }
    g.props.InsertScalar(L"P", 0.f);
    auto easing = g.compositor.CreateCubicBezierEasingFunction(float2{bezier[0], bezier[1]}, float2{bezier[2], bezier[3]});
    auto animation = g.compositor.CreateScalarKeyFrameAnimation();
    animation.InsertKeyFrame(0.f, 0.f);
    animation.InsertKeyFrame(1.f, 1.f, easing);
    animation.Duration(std::chrono::milliseconds(static_cast<int64_t>(ms)));
    g.props.StartAnimation(L"P", animation);
  } catch (...) {
  }
  return Undefined(env);
}

napi_value JsSetTarget(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  size_t argc;
  float to[4];
  if (!g.hwnd || !Args(env, info, argv, argc) || argc < 1 || !ReadRect(env, argv[0], to)) return Undefined(env);
  try {
    SetEdges(L"T", to);
  } catch (...) {
  }
  return Undefined(env);
}

napi_value JsDestroy(napi_env env, napi_callback_info) {
  Destroy();
  return Undefined(env);
}

napi_value ModuleInit(napi_env env, napi_value exports) {
  struct Fn {
    char const* name;
    napi_callback cb;
  };
  Fn fns[] = {
      {"init", JsInit},         {"hasBackdrop", JsHasBackdrop}, {"setArea", JsSetArea}, {"setStyle", JsSetStyle},
      {"show", JsShow},         {"hide", JsHide},               {"animate", JsAnimate}, {"setTarget", JsSetTarget},
      {"destroy", JsDestroy},
  };
  for (auto const& fn : fns) {
    napi_value value;
    napi_create_function(env, fn.name, NAPI_AUTO_LENGTH, fn.cb, nullptr, &value);
    napi_set_named_property(env, exports, fn.name, value);
  }
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, ModuleInit)
