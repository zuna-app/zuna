// TDLib's JSON interface, as td/telegram/td_json_client.h declares what the
// app calls of it, for the app's Swift (Zuna/Telegram/TDLibEngine.swift). The libraries are linked
// from apps/ios/.deps/tdlib (apps/ios/telegram.yml), in a build given Telegram's api_id.

#ifndef ZUNA_TDLIB_H
#define ZUNA_TDLIB_H

int td_create_client_id(void);
void td_send(int client_id, const char *request);
const char *td_receive(double timeout);
const char *td_execute(const char *request);

/// Called with what TDLib logs at or below `max_verbosity_level`: at 0, a fatal error, after which
/// TDLib ends the process as soon as the callback returns.
typedef void (*td_log_message_callback_ptr)(int verbosity_level, const char *message);
void td_set_log_message_callback(int max_verbosity_level, td_log_message_callback_ptr callback);

#endif
