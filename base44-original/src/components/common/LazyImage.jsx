import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";

export default function LazyImage({ src, alt, className, placeholder }) {
  const [isLoaded, setIsLoaded] = useState(false);
  const [imageSrc, setImageSrc] = useState(placeholder || "");

  useEffect(() => {
    const img = new Image();
    img.src = src;
    img.onload = () => {
      setImageSrc(src);
      setIsLoaded(true);
    };
  }, [src]);

  return (
    <img
      src={imageSrc}
      alt={alt}
      className={cn("transition-opacity duration-300", isLoaded ? "opacity-100" : "opacity-50", className)}
      onLoad={() => setIsLoaded(true)}
    />
  );
}