export type ServerList = Server[];

export interface Server {
  id: string;
  address: string;
  name: string;
  username: string;
}

export interface ChatMember {
  id: string;
  username: string;
  avatar: string;
  avatarIv: string;
  avatarAuthTag: string;
  identityKey: string;
}

export interface Chat {
  members: ChatMember[];
}
