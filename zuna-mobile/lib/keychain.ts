import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const SESSION_PIN_KEY = 'zuna_vault_pin';
const SESSION_DERIVED_KEY_KEY = 'zuna_vault_derived_key';
const DEVICE_ID_KEY = 'zuna_device_id';
const ENC_PRIVATE_KEY_NSE_KEY = 'zuna_enc_private_key';
const USER_MAP_NSE_KEY = 'zuna_user_map';
const ACCESS_GROUP = 'SGKB9R23YT.chat.zuna.mobile';

function secureStoreOptions(): SecureStore.SecureStoreOptions {
  const isExpoGo = Constants.appOwnership === 'expo';
  const shouldUseAccessGroup = Platform.OS === 'ios' && !isExpoGo;

  return {
    keychainService: 'zuna_vault_session',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    ...(shouldUseAccessGroup ? { accessGroup: ACCESS_GROUP } : {}),
  };
}

export async function getSessionPin(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_PIN_KEY, secureStoreOptions());
  } catch {
    return null;
  }
}

export async function setSessionPin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_PIN_KEY, pin, secureStoreOptions());
}

export async function getSessionDerivedKey(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_DERIVED_KEY_KEY, secureStoreOptions());
  } catch {
    return null;
  }
}

export async function setSessionDerivedKey(derivedKeyBase64: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_DERIVED_KEY_KEY, derivedKeyBase64, secureStoreOptions());
}

// Device ID — app-local, no cross-extension sharing needed
function deviceIdOptions(): SecureStore.SecureStoreOptions {
  return {
    keychainService: 'zuna_device',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  };
}

export async function getDeviceId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(DEVICE_ID_KEY, deviceIdOptions());
  } catch {
    return null;
  }
}

export async function setDeviceId(id: string): Promise<void> {
  await SecureStore.setItemAsync(DEVICE_ID_KEY, id, deviceIdOptions());
}

// Enc private key shared with the Notification Service Extension via keychain access group.
// Stored on every vault unlock so the NSE can decrypt incoming notifications.
function nseKeyOptions(): SecureStore.SecureStoreOptions {
  const isExpoGo = Constants.appOwnership === 'expo';
  const shouldUseAccessGroup = Platform.OS === 'ios' && !isExpoGo;
  return {
    keychainService: 'zuna_nse_keys',
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    ...(shouldUseAccessGroup ? { accessGroup: ACCESS_GROUP } : {}),
  };
}

export async function setEncPrivateKeyForNSE(encPrivateKeyB64: string): Promise<void> {
  await SecureStore.setItemAsync(ENC_PRIVATE_KEY_NSE_KEY, encPrivateKeyB64, nseKeyOptions());
}

export type NSEUserEntry = { username: string; serverAddress: string };

export async function getStoredUserMap(): Promise<Record<string, NSEUserEntry>> {
  try {
    const json = await SecureStore.getItemAsync(USER_MAP_NSE_KEY, nseKeyOptions());
    return json ? (JSON.parse(json) as Record<string, NSEUserEntry>) : {};
  } catch {
    return {};
  }
}

export async function storeUserMapForNSE(map: Record<string, NSEUserEntry>): Promise<void> {
  await SecureStore.setItemAsync(USER_MAP_NSE_KEY, JSON.stringify(map), nseKeyOptions());
}

export async function clearSession(): Promise<void> {
  try {
    await Promise.all([
      SecureStore.deleteItemAsync(SESSION_PIN_KEY, secureStoreOptions()),
      SecureStore.deleteItemAsync(SESSION_DERIVED_KEY_KEY, secureStoreOptions()),
    ]);
  } catch {
    // ignore if not found
  }
}
