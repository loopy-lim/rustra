// LynxView(UIView 서브클래스) 를 LynxViewBuilder 로 생성해 RustraModule
// (rkyv V2 fast-path LynxModule) 을 LynxConfig 에 등록한다. 이 등록이 있어야
// JS 의 globalThis.NativeModules.RustraModule 에 노출되어 configure() 가 성공한다.
// bundle 내부 App.tsx 가 addNumbers(20,22) rkyv 호출 → 결과 42 를 화면에 렌더링.
#import "ViewController.h"
#import <Lynx/LynxView.h>
#import <Lynx/LynxViewBuilder.h>
#import <Lynx/LynxConfig.h>
#import <RustraLynx/RustraModule.h>

@implementation ViewController

- (void)viewDidLoad {
  [super viewDidLoad];
  self.view.backgroundColor = [UIColor blackColor];

  // rkyv V2 fast-path 네이티브 모듈을 LynxConfig 에 등록한다.
  LynxConfig *config = [[LynxConfig alloc] initWithProvider:nil];
  [config registerModule:[RustraModule class]];

  LynxView *lynxView = [[LynxView alloc] initWithBuilderBlock:^(LynxViewBuilder *builder) {
    builder.frame = self.view.bounds;
    builder.config = config;
  }];
  lynxView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
  [self.view addSubview:lynxView];

  // 메인 번들에 포함된 ReactLynx 번들(rspeedy 빌드 산물, app.lynx.js) 을 NSData 로 읽어 직접 로드.
  NSString *path = [[NSBundle mainBundle] pathForResource:@"app.lynx" ofType:@"js"];
  NSData *template = [NSData dataWithContentsOfFile:path];
  NSLog(@"[spike-ios] loadTemplate path=%@ bytes=%lu", path, (unsigned long)template.length);
  [lynxView loadTemplate:template withURL:@"main.lynx"];
}

@end
