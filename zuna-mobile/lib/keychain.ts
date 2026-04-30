import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

const SESSION_PIN_KEY = 'zuna_vault_pin';
const ACCESS_GROUP = 'group.chat.zuna';

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

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_PIN_KEY, secureStoreOptions());
  } catch {
    // ignore if not found
  }
}
