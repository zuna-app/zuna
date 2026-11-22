// ZunaTD, the framework TDLib is linked into once, for the app and the share extension to share
// (apps/ios/telegram.yml). Everything in it is TDLib's: this file is only what the framework is
// built from, as a target links nothing without a source of its own. TDLib's functions are
// declared in TDLib.h beside it, and only those are exported (exported-symbols.txt).
#include "TDLib.h"
