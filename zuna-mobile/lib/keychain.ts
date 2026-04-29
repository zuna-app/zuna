import * as SecureStore from 'expo-secure-store';

const SESSION_PIN_KEY = 'zuna_vault_pin';

export async function getSessionPin(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(SESSION_PIN_KEY);
  } catch {
    return null;
  }
}

export async function setSessionPin(pin: string): Promise<void> {
  await SecureStore.setItemAsync(SESSION_PIN_KEY, pin);
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(SESSION_PIN_KEY);
  } catch {
    // ignore if not found
  }
}
