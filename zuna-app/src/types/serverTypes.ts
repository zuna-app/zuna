export type ServerList = Server[];

export interface Server {
  id: string;
  address: string;
  name: string;
  username: string;
}

export interface ChatMemberRaw {
  id: string;
  chatId: string;
  username: string;
  avatar: string;
  avatarIv: string;
  avatarAuthTag: string;
  identityKey: string;
}

export type ChatMember = ChatMemberRaw & {
  senderId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  unreadMessages: number;
  lastActivityAt: number;
};

export interface LastMessage {
  chatId: string;
  senderId: string;
  content: string;
  unreadMessages: number;
  lastActivityAt: number;
}

export interface Chat {
  members: ChatMember[];
}
