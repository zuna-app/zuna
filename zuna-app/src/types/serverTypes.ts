export type ServerList = Server[];

export interface Chat {
  id: string;
  username: string;
  avatar: Uint8Array;
  identityKey: string;
}

export interface Server {
  id: string;
  address: string;
  name: string;
  username: string;
}
