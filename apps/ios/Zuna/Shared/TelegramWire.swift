import Foundation
@preconcurrency import XPC

/// What the app and its Telegram helper (`ZunaTelegram`) say to each other over their XPC session
/// (docs/TELEGRAM_PLAN.md, "On the iPhone and iPad"): the desktop's frames
/// (`apps/desktop/telegram/src/frame.rs`), each a dictionary of its own.
///
/// - `j`: JSON. With an `@type` it's TDLib's own: a request from the app, an answer or an update
///   from the helper. With a `zuna` field it's theirs: `start` and `erase` from the app, the
///   door's `open` from the helper, answered with `opened` or `refused`, and `closed` either way.
/// - `d` and `b`: what a connection through the door carries, by its number, and the bytes. Each
///   is answered once it's written, and the next part of that connection waits for the answer,
///   so neither side ever holds more than one part the other hasn't taken.
/// - `file`: from the app, a file of the helper's folder by the path TDLib gave, answered with
///   it opened for reading in `fd`, or with `error`. The app copies it out: it can't read the
///   helper's folder, and the helper can't read the app's.
enum TelegramWire {
    static let json = "j"
    static let stream = "d"
    static let bytes = "b"
    static let file = "file"
    static let descriptor = "fd"
    static let error = "error"

    /// The most one part of a connection carries.
    static let mostData = 64 << 10
    /// The largest JSON either side takes: TDLib's largest answers, a long chat's history, are a few megabytes.
    static let mostJSON = 32 << 20

    static func message(json text: String) -> XPCDictionary {
        var message = XPCDictionary()
        message[json] = text
        return message
    }

    static func message(stream id: UInt32, bytes data: Data) -> XPCDictionary {
        var message = XPCDictionary()
        message[stream] = Int64(id)
        setData(data, for: bytes, in: message)
        return message
    }

    static func setData(_ data: Data, for key: String, in message: XPCDictionary) {
        message.withUnsafeUnderlyingDictionary { dictionary in
            data.withUnsafeBytes { buffer in
                xpc_dictionary_set_data(dictionary, key, buffer.baseAddress ?? UnsafeRawPointer(bitPattern: 1)!, buffer.count)
            }
        }
    }

    static func data(_ key: String, in message: XPCDictionary) -> Data? {
        message.withUnsafeUnderlyingDictionary { dictionary in
            var length = 0
            guard let pointer = xpc_dictionary_get_data(dictionary, key, &length) else { return nil }
            return Data(bytes: pointer, count: length)
        }
    }

    /// A file descriptor, which the message carries a copy of: the one given stays the caller's to close.
    /// By XPC's own call, as the dictionary's subscript for one is iOS 27's.
    static func setDescriptor(_ descriptor: Int32, in message: XPCDictionary) {
        message.withUnsafeUnderlyingDictionary { xpc_dictionary_set_fd($0, TelegramWire.descriptor, descriptor) }
    }

    /// A copy of the file descriptor a message carries, which the caller closes, or nil.
    static func descriptor(in message: XPCDictionary) -> Int32? {
        let descriptor = message.withUnsafeUnderlyingDictionary { xpc_dictionary_dup_fd($0, TelegramWire.descriptor) }
        return descriptor >= 0 ? descriptor : nil
    }

    /// A message to answer later, from another queue: XPC's own objects are safe to use from any.
    final class Answer: @unchecked Sendable {
        private let message: XPCDictionary
        init(_ message: XPCDictionary) { self.message = message }
        func reply() { message.reply(XPCDictionary()) }
    }

    /// A connection's number, if the message names one that fits.
    static func streamID(in message: XPCDictionary) -> UInt32? {
        guard let id: Int64 = message[stream], id > 0, id <= Int64(UInt32.max) else { return nil }
        return UInt32(id)
    }
}
