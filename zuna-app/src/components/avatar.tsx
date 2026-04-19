import { base64ToImageUrl, getFirstLetters } from "@/utils/basicUtils";
import { Avatar, AvatarBadge, AvatarFallback, AvatarImage } from "./ui/avatar";

export const ZunaAvatar = ({
  src,
  username,
  isOnline,
  noBadge = false,
}: {
  src?: string;
  username: string;
  isOnline: boolean;
  noBadge?: boolean;
}) => {
  return (
    <Avatar>
      <AvatarImage
        src={src ? base64ToImageUrl(src) : undefined}
        alt={`@${username}`}
      />
      <AvatarFallback>{getFirstLetters(username)}</AvatarFallback>
      {!noBadge && (
        <>
          {isOnline && (
            <AvatarBadge className="bg-emerald-500 dark:bg-emerald-700" />
          )}
          {!isOnline && (
            <AvatarBadge className="bg-gray-500 dark:bg-gray-700" />
          )}
        </>
      )}
    </Avatar>
  );
};
