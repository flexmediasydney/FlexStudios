/**
 * AIChat.jsx — Floating AI assistant chat panel.
 *
 * Desktop: fixed right side panel (w-96).
 * Mobile:  full-screen overlay (inset-0, z-50).
 *
 * Calls the `projectAIAssistant` edge function and renders streamed
 * action results inline with confirmation buttons when needed.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sparkles, Send, X, Mic, MicOff, Volume2, VolumeX, Loader2, Check, XCircle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── Helpers ─────────────────────────────────────────────────────────────────

function generateSessionId() {
  return crypto.randomUUID();
}

/** Format timestamp with date context: "Today 2:35 PM", "Yesterday 10:00 AM", or "8 Apr 2:35 PM" */
function formatMessageTime(isoString) {
  const d = new Date(isoString);
  const now = new Date();
  const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });

  if (d.toDateString() === now.toDateString()) return `Today ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;

  const date = d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  return `${date} ${time}`;
}

const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

// ── Component ───────────────────────────────────────────────────────────────

export default function AIChat({ projectId, projectTitle }) {
  const { data: user } = useCurrentUser();

  // Panel state
  const [isOpen, setIsOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  // Message state
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);

  // Session management
  const [sessionId, setSessionId] = useState(null);
  const lastActivityRef = useRef(Date.now());

  // Voice / TTS
  const [isListening, setIsListening] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(false);
  const recognitionRef = useRef(null);

  // Refs
  const scrollEndRef = useRef(null);
  const inputRef = useRef(null);

  // ── Responsive ──────────────────────────────────────────────────────────

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ── Session idle reset ──────────────────────────────────────────────────

  const getOrCreateSession = useCallback(() => {
    const now = Date.now();
    if (!sessionId || now - lastActivityRef.current > SESSION_TIMEOUT_MS) {
      const newId = generateSessionId();
      setSessionId(newId);
      lastActivityRef.current = now;
      return newId;
    }
    lastActivityRef.current = now;
    return sessionId;
  }, [sessionId]);

  // ── Auto-scroll ─────────────────────────────────────────────────────────

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  // ── Voice input (Web Speech API) ────────────────────────────────────────

  const startVoice = useCallback(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      toast.error("Speech recognition is not supported in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-AU";
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      setInput(transcript);
    };
    recognition.onerror = () => {
      setIsListening(false);
      toast.error("Voice recognition failed. Please try again.");
    };
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
  }, []);

  const stopVoice = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
  }, []);

  // ── TTS (text-to-speech) ────────────────────────────────────────────────

  const speakResponse = useCallback((text) => {
    if (!ttsEnabled || !text) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-AU";
    utterance.rate = 1.1;
    window.speechSynthesis.speak(utterance);
  }, [ttsEnabled]);

  // ── Send message ────────────────────────────────────────────────────────

  const sendMessage = useCallback(async (overrideInput) => {
    const text = overrideInput ?? input.trim();
    if (!text || isLoading) return;

    const currentSession = getOrCreateSession();
    const isVoice = typeof overrideInput === "undefined" && isListening;

    // Add user message
    const userMsg = {
      role: "user",
      content: text,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await api.functions.invoke("projectAIAssistant", {
        project_id: projectId,
        prompt_text: text,
        prompt_source: isVoice ? "voice" : "text",
        session_id: currentSession,
      });

      const assistantMsg = {
        role: "assistant",
        content: response.message || response.data?.message || "Done.",
        actions: response.actions_executed || response.data?.actions_executed || [],
        timestamp: new Date().toISOString(),
      };

      // Check if confirmation is required
      if (response.requires_confirmation || response.data?.requires_confirmation) {
        setPendingConfirmation({
          message: response.confirmation_message || response.data?.confirmation_message || "Confirm this action?",
          payload: response.confirmation_payload || response.data?.confirmation_payload || {},
        });
      }

      setMessages((prev) => [...prev, assistantMsg]);
      speakResponse(assistantMsg.content);
    } catch (err) {
      const errMsg = {
        role: "assistant",
        content: `Sorry, something went wrong: ${err.message || "Unknown error"}`,
        actions: [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, isListening, projectId, getOrCreateSession, speakResponse]);

  // ── Confirmation handlers ───────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!pendingConfirmation) return;
    const currentSession = getOrCreateSession();
    setIsLoading(true);
    setPendingConfirmation(null);

    try {
      const response = await api.functions.invoke("projectAIAssistant", {
        project_id: projectId,
        prompt_text: "__confirm__",
        prompt_source: "confirmation",
        session_id: currentSession,
        confirmation_payload: pendingConfirmation.payload,
      });

      const msg = {
        role: "assistant",
        content: response.message || response.data?.message || "Action confirmed and executed.",
        actions: response.actions_executed || response.data?.actions_executed || [],
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, msg]);
      speakResponse(msg.content);
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `Confirmation failed: ${err.message}`,
        actions: [],
        timestamp: new Date().toISOString(),
      }]);
    } finally {
      setIsLoading(false);
    }
  }, [pendingConfirmation, projectId, getOrCreateSession, speakResponse]);

  const handleCancel = useCallback(() => {
    setPendingConfirmation(null);
    setMessages((prev) => [...prev, {
      role: "assistant",
      content: "Action cancelled.",
      actions: [],
      timestamp: new Date().toISOString(),
    }]);
  }, []);

  // ── Keyboard submit ─────────────────────────────────────────────────────

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // ── Toggle button (always visible) ──────────────────────────────────────

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-[60] h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl hover:scale-105 transition-all duration-200 flex items-center justify-center"
        title="Open AI Assistant"
        aria-label="Open AI Assistant"
      >
        <Sparkles className="h-6 w-6" />
      </button>
    );
  }

  // ── Chat panel ──────────────────────────────────────────────────────────

  return (
    <div
      className={cn(
        "fixed z-[60] flex flex-col bg-card border-l shadow-2xl overflow-hidden",
        isMobile
          ? "inset-0"
          : "top-0 right-0 bottom-0 w-96"
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/50 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">AI Assistant</h2>
            {projectTitle && (
              <p className="text-xs text-muted-foreground truncate">{projectTitle}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setTtsEnabled(!ttsEnabled)}
            title={ttsEnabled ? "Disable read aloud" : "Enable read aloud"}
          >
            {ttsEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4 text-muted-foreground" />}
          </Button>
          {messages.length > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              onClick={() => { setMessages([]); setPendingConfirmation(null); setSessionId(null); }}
              title="Clear conversation"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => { setIsOpen(false); window.speechSynthesis.cancel(); }}
            title="Close"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4">
          {messages.length === 0 && (
            <div className="text-center py-12 text-muted-foreground">
              <Sparkles className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="text-sm font-medium">AI Assistant</p>
              <p className="text-xs mt-1">
                Ask me to complete tasks, add notes, update statuses, and more.
              </p>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-2 text-sm",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                )}
              >
                <p className="whitespace-pre-wrap">{msg.content}</p>

                {/* Action results */}
                {msg.actions && msg.actions.length > 0 && (
                  <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
                    {msg.actions.map((action, j) => (
                      <div key={j} className="flex items-center gap-1.5 text-xs">
                        {action.success !== false ? (
                          <Check className="h-3 w-3 text-green-500 shrink-0" />
                        ) : (
                          <XCircle className="h-3 w-3 text-red-500 shrink-0" />
                        )}
                        <span className={cn(
                          "truncate",
                          action.success !== false ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"
                        )}>
                          {action.action_type}: {action.description || action.result || "Done"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <p className="text-[10px] opacity-50 mt-1">
                  {formatMessageTime(msg.timestamp)}
                </p>
              </div>
            </div>
          ))}

          {/* Confirmation buttons */}
          {pendingConfirmation && (
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-3">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200 mb-2">
                {pendingConfirmation.message}
              </p>
              <div className="flex gap-2">
                <Button size="sm" onClick={handleConfirm} disabled={isLoading}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Confirm
                </Button>
                <Button size="sm" variant="outline" onClick={handleCancel} disabled={isLoading}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {/* Loading indicator with processing steps */}
          {isLoading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-lg px-3 py-2.5 space-y-1.5 min-w-[160px]">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                  <span className="text-xs font-medium text-foreground">Processing...</span>
                </div>
                <div className="space-y-1 pl-5.5">
                  <p className="text-[10px] text-muted-foreground animate-pulse">Understanding your request</p>
                  <p className="text-[10px] text-muted-foreground/50 animate-pulse" style={{ animationDelay: '0.5s' }}>Checking project context</p>
                  <p className="text-[10px] text-muted-foreground/30 animate-pulse" style={{ animationDelay: '1s' }}>Executing actions...</p>
                </div>
              </div>
            </div>
          )}

          <div ref={scrollEndRef} />
        </div>
      </ScrollArea>

      {/* Input area */}
      <div className="border-t p-3 shrink-0 bg-card relative z-10">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className={cn("h-9 w-9 shrink-0", isListening && "text-red-500 bg-red-50 dark:bg-red-900/20")}
            onClick={isListening ? stopVoice : startVoice}
            title={isListening ? "Stop listening" : "Voice input"}
          >
            {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </Button>
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={projectTitle ? `Ask about ${projectTitle}...` : "Add notes, update status, assign tasks..."}
            className="flex-1 text-sm"
            disabled={isLoading}
            autoComplete="off"
          />
          <Button
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={() => sendMessage()}
            disabled={!input.trim() || isLoading}
            title="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {isListening && (
          <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
            <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            Listening... speak now
          </p>
        )}
      </div>
    </div>
  );
}
