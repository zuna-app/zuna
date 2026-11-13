import CryptoKit
import JavaScriptCore
import XCTest
@testable import ZunaHost

/// `__zunaCrypto` from JavaScript, as the core bundle calls it: the primitives, and MLS between
/// two clients in the same context, the way the core runs a group. tests/e2e/test/crypto.test.ts
/// holds the same calls to the WebAssembly build's answers.
final class CryptoBridgeTests: XCTestCase {
    private var context: JSContext!
    /// Kept, as the core's runtime keeps it: MLS clients live in it.
    private var bridge: CryptoBridge!

    override func setUp() {
        context = JSContext()!
        context.exceptionHandler = { context, exception in context?.exception = exception }
        bridge = CryptoBridge()
        bridge.install(in: context)
        // What the tests below lean on: bytes from text, equality, and whether a call throws.
        run("""
            globalThis.utf8 = (text) => new Uint8Array([...unescape(encodeURIComponent(text))].map(c => c.charCodeAt(0)));
            globalThis.same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
            globalThis.throws = (body) => { try { body(); return false; } catch (error) { return error instanceof Error && error.message.length > 0; } };
            globalThis.mls = (client, method, ...args) => __zunaCrypto.mls(client, method, ...args);
            """)
    }

    @discardableResult
    private func run(_ script: String, file: StaticString = #filePath, line: UInt = #line) -> JSValue {
        let value = context.evaluateScript(script)!
        if let exception = context.exception {
            context.exception = nil
            XCTFail("JavaScript threw: \(exception.toString() ?? "")", file: file, line: line)
        }
        return value
    }

    private func string(_ script: String, line: UInt = #line) -> String? {
        run(script, line: line).toString()
    }

    func testHashesAndDerivesAsCryptoKitDoes() throws {
        XCTAssertEqual(string("__zunaCrypto.sha256(utf8('abc')).join(',')"),
                       SHA256.hash(data: Data("abc".utf8)).map(String.init).joined(separator: ","))
        let derived = HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: Data("secret".utf8)), salt: Data("salt".utf8),
                                             info: Data("info".utf8), outputByteCount: 42)
        XCTAssertEqual(string("__zunaCrypto.hkdfSha256(utf8('secret'), utf8('salt'), utf8('info'), 42).join(',')"),
                       derived.withUnsafeBytes { Data($0) }.map(String.init).joined(separator: ","))
        XCTAssertEqual(string("__zunaCrypto.randomBytes(24).length"), "24")
        XCTAssertEqual(string("same(__zunaCrypto.randomBytes(16), __zunaCrypto.randomBytes(16))"), "false")
    }

    func testStretchesPasswordsTheSameWayEachTime() {
        let result = string("""
            const salt = utf8('saltsaltsaltsalt');
            const a = __zunaCrypto.argon2id(utf8('pw'), salt, 1024, 1, 1, 32);
            const b = __zunaCrypto.argon2id(utf8('pw'), salt, 1024, 1, 1, 32);
            const c = __zunaCrypto.argon2id(utf8('pw'), utf8('othersaltothersa'), 1024, 1, 1, 32);
            [a.length, same(a, b), same(a, c), throws(() => __zunaCrypto.argon2id(utf8('pw'), salt, 1, 1, 1, 32))].join('|')
            """)
        XCTAssertEqual(result, "32|true|false|true")
    }

    func testSealsAStreamChunkByChunk() {
        let result = string("""
            const key = __zunaCrypto.randomBytes(32);
            const prefix = __zunaCrypto.randomBytes(15);
            const first = __zunaCrypto.streamSeal(key, prefix, 0, false, utf8('first'));
            const last = __zunaCrypto.streamSeal(key, prefix, 1, true, utf8('last'));
            const opened = __zunaCrypto.streamOpen(key, prefix, 1, true, last);
            [__zunaCrypto.streamOpen(key, prefix, 0, false, first).length, opened.length,
             // A chunk opened at another place, or as the last when it wasn't, is refused.
             throws(() => __zunaCrypto.streamOpen(key, prefix, 1, false, first)),
             throws(() => __zunaCrypto.streamOpen(key, prefix, 0, true, first)),
             throws(() => __zunaCrypto.streamSeal(key, utf8('short'), 0, false, utf8('x')))].join('|')
            """)
        XCTAssertEqual(result, "5|4|true|true|true")
    }

    func testSealsToAKeyAndComparesSafetyNumbers() {
        let result = string("""
            const pair = __zunaCrypto.hpkeKeygen();
            const sealed = __zunaCrypto.hpkeSeal(pair.publicKey, utf8('info'), utf8('aad'), utf8('to you'));
            const opened = __zunaCrypto.hpkeOpen(pair.secretKey, utf8('info'), utf8('aad'), sealed);
            const other = __zunaCrypto.hpkeKeygen();
            const a = __zunaCrypto.safetyDigest(utf8('alice'), utf8('bob'));
            [same(opened, utf8('to you')),
             throws(() => __zunaCrypto.hpkeOpen(other.secretKey, utf8('info'), utf8('aad'), sealed)),
             throws(() => __zunaCrypto.hpkeOpen(pair.secretKey, utf8('info'), utf8('other'), sealed)),
             throws(() => __zunaCrypto.hpkeSeal(utf8('not a key'), utf8('info'), utf8('aad'), utf8('x'))),
             same(a, __zunaCrypto.safetyDigest(utf8('bob'), utf8('alice'))),
             same(a, __zunaCrypto.safetyDigest(utf8('alice'), utf8('eve')))].join('|')
            """)
        XCTAssertEqual(result, "true|true|true|true|true|false")
    }

    func testAKeysPublicHalfComesFromItsSecretAndTokensNeedTheServersAnswer() {
        let result = string("""
            const pair = __zunaCrypto.signingKeygen();
            const blinded = __zunaCrypto.tokenBlind(2);
            [same(__zunaCrypto.signingPublic(pair.secretKey), pair.publicKey),
             throws(() => __zunaCrypto.signingPublic(utf8('short'))),
             blinded.length % 2 === 0 && blinded.length > 0,
             throws(() => __zunaCrypto.tokenBlind(0)),
             // A server's answer that doesn't fit what was asked is refused before anything is read.
             throws(() => __zunaCrypto.tokenFinalize(blinded, new Uint8Array(3), new Uint8Array(3), new Uint8Array(3)))].join('|')
            """)
        XCTAssertEqual(result, "true|true|true|true|true")
    }

    func testTwoClientsMakeAGroupJoinItAndAgreeOnItsSecrets() throws {
        run("""
            const keys = (name) => { const pair = __zunaCrypto.signingKeygen(); return { pair, client: __zunaCrypto.mlsNew(pair.publicKey, pair.secretKey, utf8(name), []) }; };
            globalThis.alice = keys('alice');
            globalThis.bob = keys('bob');
            globalThis.group = __zunaCrypto.randomBytes(16);
            globalThis.label = 'zuna/test';
            globalThis.secretOf = (who) => mls(who.client, 'exportSecret', group, label, utf8('context'), 32);
            /** Bob's state as the core would keep it, from each takeChanges. */
            globalThis.bobState = new Map();
            globalThis.persistBob = () => {
                const changes = mls(bob.client, 'takeChanges');
                for (const [key, value] of changes.set) bobState.set(key.join(','), [key, value]);
                for (const key of changes.deleted) bobState.delete(key.join(','));
                return Object.keys(changes).sort().join(',');
            };
            """)

        // Bob's key package names him, and Alice adds him with it.
        XCTAssertEqual(string("""
            globalThis.package = mls(bob.client, 'generateKeyPackage', false);
            [same(mls(alice.client, 'keyPackageCredential', package), utf8('bob')),
             mls(alice.client, 'keyPackageSignatureKey', package).length > 0,
             persistBob(),
             mls(alice.client, 'hasGroup', group),
             mls(alice.client, 'createGroup', group, null),
             mls(alice.client, 'hasGroup', group)].join('|')
            """), "true|true|deleted,set|false|0|true")
        XCTAssertEqual(string("""
            const pending = mls(alice.client, 'commitChanges', group, [package], new Uint32Array(0), null);
            [Object.keys(pending).sort().join(','), pending.welcome instanceof Uint8Array, mls(alice.client, 'hasPending', group),
             mls(alice.client, 'mergePending', group), mls(alice.client, 'hasPending', group),
             JSON.stringify(mls(bob.client, 'joinFromWelcome', pending.welcome, group).epoch), persistBob()].join('|')
            """), "commit,groupInfo,welcome|true|true|1|false|1|deleted,set")
        XCTAssertEqual(string("""
            const members = mls(bob.client, 'members', group);
            [mls(bob.client, 'epoch', group), mls(bob.client, 'ownLeafIndex', group), members.length,
             members.map(m => m.leafIndex).join(','), same(members[0].credential, utf8('alice')), members[1].signatureKey.length > 0,
             same(secretOf(alice), secretOf(bob)), mls(bob.client, 'roster', group) === null].join('|')
            """), "1|1|2|0,1|true|true|true|true")

        // A commit of Bob's, which Alice takes in, with the next epoch's secret known before it's merged.
        XCTAssertEqual(string("""
            const update = mls(bob.client, 'commitChanges', group, [], new Uint32Array(0), null);
            const next = mls(bob.client, 'exportPendingSecret', group, label, utf8('context'), 32);
            const processed = mls(alice.client, 'processCommit', group, update.commit);
            [update.welcome === null, processed.epoch, same(processed.senderCredential, utf8('bob')), processed.isExternal,
             processed.addedCredentials.length, processed.removedCredentials.length, processed.selfRemoved,
             mls(bob.client, 'mergePending', group), same(secretOf(alice), next), same(secretOf(bob), next), persistBob()].join('|')
            """), "true|2|true|false|0|0|false|2|true|true|deleted,set")

        // A commit that loses its race is cleared, or rolled back with what wasn't kept yet.
        XCTAssertEqual(string("""
            mls(bob.client, 'commitChanges', group, [], new Uint32Array(0), null);
            mls(bob.client, 'clearPending', group);
            const cleared = mls(bob.client, 'hasPending', group);
            mls(bob.client, 'commitChanges', group, [], new Uint32Array(0), null);
            mls(bob.client, 'rollback');
            [cleared, mls(bob.client, 'hasPending', group), mls(bob.client, 'epoch', group)].join('|')
            """), "false|false|2")

        // Someone joins by the group's info on their own, and both see it.
        XCTAssertEqual(string("""
            globalThis.carol = keys('carol');
            const joined = mls(carol.client, 'joinExternal', group, mls(alice.client, 'exportGroupInfo', group));
            const seen = mls(bob.client, 'processCommit', group, joined.commit);
            mls(alice.client, 'processCommit', group, joined.commit);
            persistBob();
            [joined.epoch, seen.isExternal, same(seen.senderCredential, utf8('carol')), same(secretOf(carol), secretOf(alice)),
             same(secretOf(bob), secretOf(alice))].join('|')
            """), "3|true|true|true|true")

        // Bob's kept state brings him back as he was.
        XCTAssertEqual(string("""
            const restored = __zunaCrypto.mlsNew(bob.pair.publicKey, bob.pair.secretKey, utf8('bob'), [...bobState.values()]);
            __zunaCrypto.mlsFree(bob.client);
            const gone = throws(() => mls(bob.client, 'epoch', group));
            bob.client = restored;
            [gone, mls(bob.client, 'epoch', group), same(secretOf(bob), secretOf(alice))].join('|')
            """), "true|3|true")

        // A new certificate goes into Bob's key packages at once, and into his leaf with his next commit.
        XCTAssertEqual(string("""
            mls(bob.client, 'setCredential', utf8('bob, generation 1'));
            const renewed = same(mls(alice.client, 'keyPackageCredential', mls(bob.client, 'generateKeyPackage', true)), utf8('bob, generation 1'));
            const commit = mls(bob.client, 'commitChanges', group, [], new Uint32Array(0), null).commit;
            mls(bob.client, 'mergePending', group);
            mls(alice.client, 'processCommit', group, commit);
            mls(carol.client, 'processCommit', group, commit);
            [renewed, mls(alice.client, 'members', group).some(m => same(m.credential, utf8('bob, generation 1')))].join('|')
            """), "true|true")

        // Alice removes Bob, who learns it, and forgets the group.
        XCTAssertEqual(string("""
            const leaf = mls(bob.client, 'ownLeafIndex', group);
            const removal = mls(alice.client, 'commitChanges', group, [], new Uint32Array([leaf]), null);
            mls(alice.client, 'mergePending', group);
            const learnt = mls(bob.client, 'processCommit', group, removal.commit);
            mls(bob.client, 'deleteGroup', group);
            [learnt.selfRemoved, learnt.removedCredentials.length, mls(bob.client, 'hasGroup', group),
             throws(() => mls(bob.client, 'epoch', group)), throws(() => mls(bob.client, 'members', group)),
             throws(() => mls(bob.client, 'noSuchMethod')), throws(() => mls(9999, 'epoch', group)),
             throws(() => mls(alice.client, 'processCommit', group, utf8('not a commit'))),
             throws(() => mls(alice.client, 'joinFromWelcome', utf8('not a welcome'), group))].join('|')
            """), "true|1|false|true|true|true|true|true|true")
    }

    func testAGroupCanCarryARoster() {
        // The roster is the core's own bytes, kept in the group's context and handed back as they were.
        XCTAssertEqual(string("""
            const pair = __zunaCrypto.signingKeygen();
            const client = __zunaCrypto.mlsNew(pair.publicKey, pair.secretKey, utf8('dana'), []);
            const id = __zunaCrypto.randomBytes(16);
            mls(client, 'createGroup', id, utf8('roster one'));
            const first = mls(client, 'roster', id);
            mls(client, 'commitChanges', id, [], new Uint32Array(0), utf8('roster two'));
            mls(client, 'mergePending', id);
            [same(first, utf8('roster one')), same(mls(client, 'roster', id), utf8('roster two'))].join('|')
            """), "true|true")
    }
}
