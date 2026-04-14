import { Server } from "@/types/serverTypes";

export const AppServer = ({ server }: { server: Server }) => {
  return (
    <div className="text-center">
      <p className="font-medium text-foreground">{server.name}</p>
      <p className="mt-1 text-xs">{server.address}</p>
    </div>
  );
};
