import Foundation
import JavaScriptCore

/// Moves bytes between Swift and JavaScript typed arrays through the
/// JavaScriptCore C API, without going through strings.
enum JSBytes {
    /// Copies bytes into a new Uint8Array.
    static func make(_ data: Data, in context: JSContext) -> JSValue {
        guard let ctx = context.jsGlobalContextRef else { return JSValue(undefinedIn: context) }
        var exception: JSValueRef?
        guard let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, data.count, &exception) else {
            return JSValue(undefinedIn: context)
        }
        if !data.isEmpty, let pointer = JSObjectGetTypedArrayBytesPtr(ctx, array, &exception) {
            let offset = JSObjectGetTypedArrayByteOffset(ctx, array, &exception)
            data.withUnsafeBytes { source in
                (pointer + offset).copyMemory(from: source.baseAddress!, byteCount: data.count)
            }
        }
        return JSValue(jsValueRef: array, in: context)
    }

    /// Copies the bytes a typed array or ArrayBuffer views. Nil for anything else.
    static func read(_ value: JSValue?) -> Data? {
        guard let value, let context = value.context, let ctx = context.jsGlobalContextRef,
              let ref = value.jsValueRef else { return nil }
        var exception: JSValueRef?
        let type = JSValueGetTypedArrayType(ctx, ref, &exception)
        if type == kJSTypedArrayTypeNone { return nil }
        guard let object = JSValueToObject(ctx, ref, &exception) else { return nil }
        if type == kJSTypedArrayTypeArrayBuffer {
            let length = JSObjectGetArrayBufferByteLength(ctx, object, &exception)
            guard length > 0, let pointer = JSObjectGetArrayBufferBytesPtr(ctx, object, &exception) else { return Data() }
            return Data(bytes: pointer, count: length)
        }
        let length = JSObjectGetTypedArrayByteLength(ctx, object, &exception)
        guard length > 0, let pointer = JSObjectGetTypedArrayBytesPtr(ctx, object, &exception) else { return Data() }
        // The pointer is to the start of the underlying buffer, not of this view.
        let offset = JSObjectGetTypedArrayByteOffset(ctx, object, &exception)
        return Data(bytes: pointer + offset, count: length)
    }

    /// Reads a Uint32Array (such as the leaves to remove in a commit).
    static func readUInt32s(_ value: JSValue?) -> [UInt32] {
        guard let data = read(value) else { return [] }
        return data.withUnsafeBytes { raw in
            (0..<(data.count / 4)).map { raw.loadUnaligned(fromByteOffset: $0 * 4, as: UInt32.self) }
        }
    }
}

extension JSValue {
    /// The elements of a JavaScript array.
    var arrayElements: [JSValue] {
        let count = Int(forProperty("length")?.toInt32() ?? 0)
        return (0..<count).compactMap { atIndex($0) }
    }
}
