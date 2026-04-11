import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

export default function UserAvatar({ name, email, src, size = "default" }) {
  const sizeMap = { small: "h-8 w-8", default: "h-10 w-10", large: "h-12 w-12" };
  const textSizeMap = { small: "text-xs", default: "text-sm", large: "text-base" };
  const initials = (name || email || "?")
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);

  return (
    <Avatar className={sizeMap[size]} title={name || email}>
      {src && <AvatarImage src={src} alt={name || email || 'User avatar'} />}
      <AvatarFallback
        className={`bg-primary/10 text-primary font-medium ${textSizeMap[size]}`}
        aria-label={name || email || 'User avatar'}
      >
        {initials}
      </AvatarFallback>
    </Avatar>
  );
}