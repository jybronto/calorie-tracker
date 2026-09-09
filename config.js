// Публичный конфиг веб-приложения Firebase.
// Эти значения НЕ секретны — их можно коммитить (доступ ограничивают правила безопасности Firestore).
// Возьми их в консоли Firebase: Project settings → General → Your apps → SDK setup and configuration.
export const firebaseConfig = {
  apiKey: "AIzaSyDe6ntpXzXptZw2JAiJtBdmvjKfaChtydQ",
  authDomain: "calorie-tracker-e6c92.firebaseapp.com",
  projectId: "calorie-tracker-e6c92",
  storageBucket: "calorie-tracker-e6c92.firebasestorage.app",
  messagingSenderId: "975443487759",
  appId: "1:975443487759:web:26aa3410fced796102877a",
};

// Дневная цель по калориям по умолчанию (можно менять на странице).
export const DEFAULT_CALORIE_GOAL = 2000;
