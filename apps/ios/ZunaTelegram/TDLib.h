// TDLib's JSON interface, as td/telegram/td_json_client.h declares it, for the helper's Swift. The
// libraries are linked from apps/ios/.deps/tdlib (apps/ios/project.yml).

#ifndef ZUNA_TDLIB_H
#define ZUNA_TDLIB_H

int td_create_client_id(void);
void td_send(int client_id, const char *request);
const char *td_receive(double timeout);
const char *td_execute(const char *request);

#endif
