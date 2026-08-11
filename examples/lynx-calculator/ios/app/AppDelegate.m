// LynxEnv 글로벌 초기화 후 root ViewController(= LynxView 호스트) 를 띄운다.
// Lynx 공식 가이드: LynxEnv 초기화는 모든 Lynx API 호출 전.
#import "AppDelegate.h"
#import <Lynx/LynxEnv.h>
#import "ViewController.h"

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  // Lynx 글로벌 초기화. RustraModule(LynxModule) 은 Podfile 의 RustraLynx pod 가
  // Lynx 모듈 레지스트리에 등록한다 — JS 의 NativeModules.RustraModule.invokeRkyvV2 로 노출.
  [LynxEnv sharedInstance];

  self.window = [[UIWindow alloc] initWithFrame:[UIScreen mainScreen].bounds];
  self.window.rootViewController = [[ViewController alloc] init];
  [self.window makeKeyAndVisible];
  return YES;
}

@end
