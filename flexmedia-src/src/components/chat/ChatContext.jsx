import React, { createContext, useContext, useState } from 'react';

const ChatContext = createContext(null);

export function ChatProvider({ children }) {
  const [openChats, setOpenChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);

  const openChat = (chat) => {
    const chatKey = `${chat.type}:${chat.type === 'task' ? chat.taskId : 'project'}`;
    const existing = openChats.find(c => `${c.type}:${c.type === 'task' ? c.taskId : 'project'}` === chatKey);
    
    if (!existing) {
      setOpenChats(prev => [...prev, chat]);
    }
    setActiveChat(chatKey);
  };

  const closeChat = (type, id) => {
    const chatKey = `${type}:${id}`;
    setOpenChats(prev => {
      const remaining = prev.filter(c => `${c.type}:${c.type === 'task' ? c.taskId : 'project'}` !== chatKey);
      // Use setActiveChat inside the updater to avoid stale closure over openChats
      setActiveChat(current => {
        if (current !== chatKey) return current;
        return remaining.length > 0
          ? `${remaining[0].type}:${remaining[0].type === 'task' ? remaining[0].taskId : 'project'}`
          : null;
      });
      return remaining;
    });
  };

  const closeAllChats = () => {
    setOpenChats([]);
    setActiveChat(null);
  };

  return (
    <ChatContext.Provider value={{ openChats, activeChat, setActiveChat, openChat, closeChat, closeAllChats }}>
      {children}
    </ChatContext.Provider>
  );
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error('useChat must be used within ChatProvider');
  }
  return context;
}