import { useState, useMemo, useDeferredValue } from "react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Search } from "lucide-react";
import { useEmotes } from "@/hooks/ui/useEmotes";
import { EmojiConvertor } from "emoji-js";

const emojiConvertor = new EmojiConvertor();
emojiConvertor.replace_mode = "unified";
emojiConvertor.allow_native = true;
(emojiConvertor as any).init_colons();

type NativeEmoji = { name: string; char: string };

const allNativeEmoji: NativeEmoji[] = (() => {
  const result: NativeEmoji[] = [];
  const colonsMap = (emojiConvertor as any).map?.colons as
    | Record<string, string>
    | undefined;
  if (!colonsMap) return result;
  for (const name of Object.keys(colonsMap)) {
    const char = emojiConvertor.replace_colons(`:${name}:`);
    if (char && char !== `:${name}:`) {
      result.push({ name, char });
    }
  }
  return result;
})();

interface EmotePickerProps {
  onSelect: (value: string) => void;
  sevenTvEnabled: boolean;
  sevenTvEmotesSet: string | null;
}

export function EmotePicker({
  onSelect,
  sevenTvEnabled,
  sevenTvEmotesSet,
}: EmotePickerProps) {
  const { emoteMap, loading } = useEmotes(sevenTvEmotesSet, sevenTvEnabled);
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);

  const sevenTvEntries = useMemo(() => {
    const all = Array.from(emoteMap.entries());
    const q = deferredSearch.toLowerCase().trim();
    return q ? all.filter(([name]) => name.toLowerCase().includes(q)) : all;
  }, [emoteMap, deferredSearch]);

  const nativeEmojiEntries = useMemo(() => {
    const q = deferredSearch.toLowerCase().trim();
    return q
      ? allNativeEmoji.filter(({ name }) => name.toLowerCase().includes(q))
      : allNativeEmoji;
  }, [deferredSearch]);

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground/50 pointer-events-none" />
        <Input
          autoFocus
          placeholder="Search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-8 h-7 text-xs"
        />
      </div>

      <Tabs defaultValue={sevenTvEnabled ? "7tv" : "emoji"}>
        <TabsList className="w-full h-7 mb-1">
          {sevenTvEnabled && (
            <TabsTrigger value="7tv" className="flex-1 text-xs h-full">
              7TV
            </TabsTrigger>
          )}
          <TabsTrigger value="emoji" className="flex-1 text-xs h-full">
            Emoji
          </TabsTrigger>
        </TabsList>

        {sevenTvEnabled && (
          <TabsContent value="7tv">
            <div className="h-52 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]">
              {loading ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Loading emotes…
                </div>
              ) : sevenTvEntries.length === 0 ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  No emotes found
                </div>
              ) : (
                <div className="grid grid-cols-7 gap-0.5">
                  {sevenTvEntries.slice(0, 140).map(([name, url]) => (
                    <Tooltip key={name}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => onSelect(name)}
                          className="flex items-center justify-center rounded-md p-1 hover:bg-muted/60 transition-colors"
                        >
                          <img
                            src={url}
                            alt={name}
                            className="h-7 w-7 object-contain"
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        {name}
                      </TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>
        )}

        <TabsContent value="emoji">
          <div className="h-52 overflow-y-auto [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]">
            {nativeEmojiEntries.length === 0 ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                No emoji found
              </div>
            ) : (
              <div className="grid grid-cols-7 gap-0.5">
                {nativeEmojiEntries.slice(0, 280).map(({ name, char }) => (
                  <Tooltip key={name}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => onSelect(char)}
                        className="flex items-center justify-center rounded-md p-1 hover:bg-muted/60 transition-colors text-xl leading-none"
                      >
                        {char}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="text-xs">
                      {name}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
