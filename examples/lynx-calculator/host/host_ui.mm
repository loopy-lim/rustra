// host_ui.mm — macOS AppKit bridge for the rustra × Lynx host.
//
// Task 7 (native window/surface): the windowless software renderer produces an
// RGBA buffer per frame (OnSoftwarePresent). This module blits that buffer into
// a real NSWindow's layer, proving criteria 1 (macOS native window) + 2 (Lynx
// surface displayed) WITHOUT running [NSApp run] — which would clash with the
// host's manual FML pump. Instead we interleave a non-blocking AppKit event
// drain with the pump loop and rely on Core Animation's own render server +
// an explicit [CATransaction flush] to composite each frame.
//
// All functions MUST be called on the main thread (the pump loop), per AppKit.
#include <Cocoa/Cocoa.h>
#include <CoreGraphics/CoreGraphics.h>
#include <QuartzCore/QuartzCore.h>
#include <ImageIO/ImageIO.h>
#include <cstdlib>
#include <cstring>

static NSWindow *g_window = nil;
static NSView *g_view = nil;
static CALayer *g_layer = nil;
static BOOL g_should_close = NO;

@interface RustraWinDelegate : NSObject <NSWindowDelegate>
@end
@implementation RustraWinDelegate
- (void)windowWillClose:(NSNotification __unused *)notification {
  g_should_close = YES;
}
@end

static RustraWinDelegate *g_win_delegate = nil;

// CGDataProvider release callback: frees the malloc'd RGBA copy when Core
// Animation releases the CGImage (i.e. when the layer swaps in the next frame).
// This gives the CGImage a stable backing buffer independent of the host's
// g_pixels vector, which may be overwritten by the next present.
static void free_rgba_copy(void *info, const void *data, size_t size) {
  (void)data;
  (void)size;
  std::free(info);
}

// Create the application, a minimal menu (so the app registers as a regular,
// activatable app), and a titled+closable window whose content view is a
// layer-hosting view scaled to the frame's pixel size (assumes @2x Retina).
extern "C" void rustra_ui_init(uint32_t pixel_w, uint32_t pixel_h) {
  if (g_window) return;
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

    // Minimal main menu — a regular app without one can fail to become active.
    NSMenu *menu = [[NSMenu alloc] init];
    NSMenuItem *app_item = [[NSMenuItem alloc] init];
    [menu addItem:app_item];
    NSMenu *app_menu = [[NSMenu alloc] init];
    [app_menu addItemWithTitle:@"Quit rustra+Lynx"
                         action:@selector(terminate:)
                  keyEquivalent:@"q"];
    [app_item setSubmenu:app_menu];
    [NSApp setMainMenu:menu];

    g_win_delegate = [[RustraWinDelegate alloc] init];

    // Logical size at @2x, capped to the main screen's visible frame.
    CGFloat scale = 2.0;
    CGFloat lw = (CGFloat)pixel_w / scale;
    CGFloat lh = (CGFloat)pixel_h / scale;
    NSScreen *screen = [NSScreen mainScreen];
    if (screen) {
      if (lh > screen.visibleFrame.size.height) {
        CGFloat k = screen.visibleFrame.size.height / lh;
        lh *= k;
        lw *= k;
      }
      if (lw > screen.visibleFrame.size.width) {
        CGFloat k = screen.visibleFrame.size.width / lw;
        lw *= k;
        lh *= k;
      }
    }
    lw = lw < 1 ? 1 : lw;
    lh = lh < 1 ? 1 : lh;

    NSRect frame = NSMakeRect(0, 0, lw, lh);
    NSUInteger style = NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                       NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable;
    g_window = [[NSWindow alloc] initWithContentRect:frame
                                           styleMask:style
                                             backing:NSBackingStoreBuffered
                                               defer:NO];
    [g_window setTitle:@"rustra + Lynx"];
    [g_window setDelegate:g_win_delegate];
    [g_window center];

    g_view = [[NSView alloc] initWithFrame:frame];
    [g_view setWantsLayer:YES];
    g_layer = [g_view layer];
    if (!g_layer) {
      g_layer = [CALayer layer];
      [g_view setLayer:g_layer];
    }
    [g_layer setContentsGravity:kCAGravityResizeAspect];
    [g_layer setContentsScale:scale];
    [g_layer setBackgroundColor:CGColorGetConstantColor(kCGColorBlack)];
    [g_window setContentView:g_view];

    [NSApp finishLaunching];
    [g_window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];
    fprintf(stderr, "[rustra] NSWindow created: %.0fx%.0f pt (frame %ux%u px)\n",
            lw, lh, pixel_w, pixel_h);
  }
}

// Blit an RGBA buffer into the window's layer as a CGImage. Copies the buffer
// (ownership handed to the provider's release callback) so the image outlives
// the caller's buffer.
extern "C" void rustra_ui_blit(const uint8_t *rgba, uint32_t pixel_w,
                               uint32_t pixel_h) {
  if (!g_layer || !rgba || pixel_w == 0 || pixel_h == 0) return;
  @autoreleasepool {
    size_t bytes_per_row = (size_t)pixel_w * 4;
    size_t sz = bytes_per_row * (size_t)pixel_h;
    uint8_t *copy = (uint8_t *)std::malloc(sz);
    if (!copy) return;
    std::memcpy(copy, rgba, sz);

    CGDataProviderRef provider =
        CGDataProviderCreateWithData(copy, copy, sz, free_rgba_copy);
    if (!provider) {
      std::free(copy);
      return;
    }
    CGColorSpaceRef cs = CGColorSpaceCreateDeviceRGB();
    CGImageRef img =
        CGImageCreate(pixel_w, pixel_h, 8, 32, bytes_per_row, cs,
                      kCGImageAlphaPremultipliedLast, provider, nullptr, false,
                      kCGRenderingIntentDefault);
    CGColorSpaceRelease(cs);
    CGDataProviderRelease(provider);
    if (img) {
      [g_layer setContents:(__bridge id)img];
      CGImageRelease(img);
      [CATransaction flush];
    }
  }
}

// Drain pending AppKit events without blocking (distantPast = return
// immediately if none). This keeps the window live/responsive and lets Core
// Animation commit, coexisting with the host's manual FML pump.
extern "C" void rustra_ui_poll_events(void) {
  if (!g_window) return;
  @autoreleasepool {
    NSEvent *event = nil;
    while ((event = [NSApp nextEventMatchingMask:NSEventMaskAny
                                       untilDate:[NSDate distantPast]
                                          inMode:NSDefaultRunLoopMode
                                         dequeue:YES])) {
      [NSApp sendEvent:event];
    }
  }
}

extern "C" bool rustra_ui_should_close(void) { return g_should_close ? true : false; }

// Request a graceful close from a signal handler (SIGTERM/SIGINT): the pump
// loop sees should_close() and exits cleanly, so post-loop work (layer dump,
// frame.raw write) still runs before the process exits.
extern "C" void rustra_ui_request_close(void) { g_should_close = YES; }

// Dump the window's CURRENT layer.contents (the composited surface backing) to
// a PNG. The host process owns this window, so no Screen-Recording TCC prompt
// is needed (unlike cross-process capture). Reading back layer.contents proves
// the surface the window is displaying is exactly the blitted RGBA.
extern "C" bool rustra_ui_dump_layer_png(const char *path) {
  if (!g_layer || !path) return false;
  @autoreleasepool {
    id contents = [g_layer contents];
    if (!contents) return false;
    CGImageRef img = (__bridge CGImageRef)contents;
    NSString *ns_path = [NSString stringWithUTF8String:path];
    NSURL *url = [NSURL fileURLWithPath:ns_path];
    CGImageDestinationRef dest = CGImageDestinationCreateWithURL(
        (__bridge CFURLRef)url, CFSTR("public.png"), 1, nullptr);
    if (!dest) return false;
    CGImageDestinationAddImage(dest, img, nullptr);
    bool ok = CGImageDestinationFinalize(dest);
    CFRelease(dest);
    return ok ? true : false;
  }
}

extern "C" void rustra_ui_shutdown(void) {
  @autoreleasepool {
    g_layer = nil;
    g_view = nil;
    g_window = nil;
    g_win_delegate = nil;
  }
}
