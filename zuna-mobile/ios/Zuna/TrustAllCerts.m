#import <Foundation/Foundation.h>
#import <CFNetwork/CFNetwork.h>
#import <objc/runtime.h>

typedef void (^ZunaAuthChallengeHandler)(NSURLSessionAuthChallengeDisposition, NSURLCredential *_Nullable);

static void ZunaPatchSSLChallenge(Class _Nullable cls) {
    if (!cls) return;

    // Session-level: URLSession:didReceiveChallenge:completionHandler:
    {
        SEL sel = @selector(URLSession:didReceiveChallenge:completionHandler:);
        IMP imp = imp_implementationWithBlock(^(id _s,
                                                NSURLSession *session,
                                                NSURLAuthenticationChallenge *challenge,
                                                ZunaAuthChallengeHandler handler) {
            if ([challenge.protectionSpace.authenticationMethod
                 isEqualToString:NSURLAuthenticationMethodServerTrust]) {
                handler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]);
            } else {
                handler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
            }
        });
        if (!class_addMethod(cls, sel, imp, "v@:@@@?")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }

    // Task-level: URLSession:task:didReceiveChallenge:completionHandler:
    {
        SEL sel = @selector(URLSession:task:didReceiveChallenge:completionHandler:);
        IMP imp = imp_implementationWithBlock(^(id _s,
                                                NSURLSession *session,
                                                NSURLSessionTask *task,
                                                NSURLAuthenticationChallenge *challenge,
                                                ZunaAuthChallengeHandler handler) {
            if ([challenge.protectionSpace.authenticationMethod
                 isEqualToString:NSURLAuthenticationMethodServerTrust]) {
                handler(NSURLSessionAuthChallengeUseCredential,
                        [NSURLCredential credentialForTrust:challenge.protectionSpace.serverTrust]);
            } else {
                handler(NSURLSessionAuthChallengePerformDefaultHandling, nil);
            }
        });
        if (!class_addMethod(cls, sel, imp, "v@:@@@@?")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }
}

// RCTWebSocketModule uses SocketRocket (SRWebSocket) for all WSS connections.
// SSL validation in SocketRocket happens at two levels:
//
// 1. SecureTransport (OS-level, during TLS handshake):
//    SRSecurityPolicy.updateSecurityOptionsInStream: sets stream SSL properties.
//    The default sets kCFStreamSSLValidatesCertificateChain=YES, which causes
//    error -9807 (errSSLXCertChainInvalid) for self-signed certs before any
//    app-level code runs.
//
// 2. App-level (post-handshake):
//    SRSecurityPolicy.evaluateServerTrust:forDomain: is an additional check
//    after the TLS handshake completes.
//
// Both must be patched to allow self-signed certificates.
static void ZunaPatchSocketRocket(void) {
    Class cls = NSClassFromString(@"SRSecurityPolicy");
    if (!cls) return;

    // Patch 1: disable SecureTransport-level chain validation so the TLS
    // handshake succeeds even with a self-signed certificate.
    {
        SEL sel = @selector(updateSecurityOptionsInStream:);
        IMP imp = imp_implementationWithBlock(^(id _s, NSStream *stream) {
            NSDictionary *sslSettings = @{
                (__bridge NSString *)kCFStreamSSLValidatesCertificateChain: @NO
            };
            [stream setProperty:sslSettings
                         forKey:(__bridge NSString *)kCFStreamPropertySSLSettings];
        });
        if (!class_addMethod(cls, sel, imp, "v@:@")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }

    // Patch 2: accept all certificates at the app-level post-handshake check.
    {
        SEL sel = @selector(evaluateServerTrust:forDomain:);
        IMP imp = imp_implementationWithBlock(^BOOL(id _s, void *serverTrust, NSString *domain) {
            return YES;
        });
        if (!class_addMethod(cls, sel, imp, "B@:^v@")) {
            method_setImplementation(class_getInstanceMethod(cls, sel), imp);
        }
    }
}

@interface ZunaTrustAllCerts : NSObject
@end

@implementation ZunaTrustAllCerts
+ (void)load {
    // Covers fetch / XMLHttpRequest (old arch + new arch)
    ZunaPatchSSLChallenge(NSClassFromString(@"RCTHTTPRequestHandler"));
    // Covers WebSocket session-level challenges (new arch fallback path)
    ZunaPatchSSLChallenge(NSClassFromString(@"RCTWebSocketModule"));
    ZunaPatchSSLChallenge(NSClassFromString(@"NativeWebSocketModule"));
    // Covers WSS via SocketRocket (the actual path used by RCTWebSocketModule)
    ZunaPatchSocketRocket();
}
@end
