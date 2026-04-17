package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var (
	activeModules = make(map[int]net.Conn)
	usingDevice   = make(map[int][]int)
	modulesMutex  sync.RWMutex
	jwtSecret     = []byte("go&&sheregesh")
)

type ListDivases struct {
	Id      int    `json:"id"`
	Text    string `json:"text"`
	Devices []int  `json:"devices"`
}

type Result struct {
	IdCommand int    `json:"id_command"`
	Status    string `json:"status"`
}

type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func handleConnection(conn net.Conn, s *Storage) {
	defer conn.Close()

	reader := bufio.NewReader(conn)
	data, err := reader.ReadBytes('\n')
	var mes Message
	if err := json.Unmarshal(data, &mes); err != nil {
		log.Printf("Ошибка парсинга JSON: %v", err)
		return
	}

	if mes.Type != "registration" {
		log.Println("полученно неверное сообщение")
		return
	}
	var listDivases ListDivases
	if err := json.Unmarshal(mes.Data, &listDivases); err != nil {
		log.Printf("Ошибка парсинга ListDivases: %v", err)
		return
	}

	modulesMutex.Lock()
	activeModules[listDivases.Id] = conn
	usingDevice[listDivases.Id] = listDivases.Devices
	modulesMutex.Unlock()

	for {
		conn.SetReadDeadline(time.Now().Add(10 * time.Minute))
		data, err = reader.ReadBytes('\n')
		if err != nil {
			if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
				log.Println("Таймаут чтения, закрываем соединение")
			} else if err.Error() == "EOF" {
				log.Println("Клиент закрыл соединение")
			} else {
				log.Printf("Ошибка чтения: %v", err)
			}
			modulesMutex.Lock()
			delete(activeModules, listDivases.Id)
			delete(usingDevice, listDivases.Id)
			modulesMutex.Unlock()

			return
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Printf("Ошибка парсинга JSON: %v", err)
			continue
		}

		switch msg.Type {
		case "control":
			var control Controls
			if err := json.Unmarshal(msg.Data, &control); err != nil {
				log.Printf("Ошибка парсинга JSON: %v", err)
				continue
			}
			err = s.writeNewControl(control)
			if err != nil {
				log.Println(err)
			}
			log.Println("данные записаны для счетчика:", control.IdCounter)
		case "result":
			var result Result
			if err := json.Unmarshal(msg.Data, &result); err != nil {
				log.Printf("Ошибка парсинга JSON: %v", err)
				continue
			}
			err = s.updateCommandStatus(result.Status, result.IdCommand)
			if err != nil {
				log.Println("Ошибка обновления данных:", err)
				continue
			}
		}
	}
}

func verifyToken(tokenString string) (*jwt.Token, error) {
	return jwt.Parse(tokenString, func(token *jwt.Token) (interface{}, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("неверный метод подписи: %v", token.Header["alg"])
		}
		return jwtSecret, nil
	})
}

func authMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenString := r.Header.Get("Authorization")
		if tokenString == "" {
			http.Error(w, "Authorization is missing", http.StatusUnauthorized)
			return
		}
		tokenString = strings.TrimPrefix(tokenString, "Bearer ")

		token, err := verifyToken(tokenString)
		if err != nil || !token.Valid {
			http.Error(w, "Invalid or expired token", http.StatusUnauthorized)
			return
		}

		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			http.Error(w, "Invalid token claims", http.StatusUnauthorized)
			return
		}

		userIDRaw, exists := claims["user_id"]
		if !exists || userIDRaw == nil {
			http.Error(w, "Invalid token: missing user_id", http.StatusUnauthorized)
			return
		}

		userID, ok := userIDRaw.(float64)
		if !ok {
			http.Error(w, "Invalid token: user_id is not a number", http.StatusUnauthorized)
			return
		}

		status, ok := claims["status"].(string)
		if !ok {
			status = "user"
		}

		ctx := context.WithValue(r.Context(), "user_id", int(userID))
		ctx = context.WithValue(ctx, "status", status)

		next(w, r.WithContext(ctx))
	}
}

func adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		role := r.Context().Value("role").(string)
		if role != "admin" {
			http.Error(w, "Доступ запрещён", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func corsMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Разрешаем запросы с любого источника (для разработки)
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		w.Header().Set("Access-Control-Allow-Credentials", "true")

		// Обрабатываем preflight запросы (OPTIONS)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusOK)
			return
		}

		next(w, r)
	}
}

func searchDevice(list []int, ip int) bool {
	for _, value := range list {
		if value == ip {
			return true
		}
	}
	return false
}

func searchIpModule(ipDivase int) int {
	for idModule, listDivase := range usingDevice {
		if searchDevice(listDivase, ipDivase) {
			return idModule
		}
	}
	return -1
}

func searchConnection(ip int) net.Conn {
	if conn, inMap := activeModules[ip]; inMap {
		return conn
	}
	return nil
}

func sendingCommand(com Commands) error {
	modulesMutex.RLock()
	ip := searchIpModule(com.IdCounter)
	modulesMutex.RUnlock()
	if ip == -1 {
		return fmt.Errorf("счётчик %d не зарегистрирован ни на одном модуле", com.IdCounter)
	}
	modulesMutex.RLock()
	conn := searchConnection(ip)
	modulesMutex.RUnlock()
	if conn == nil {
		log.Println("Соеденение не найдено")
		return fmt.Errorf("отсутствует соединение")
	}

	c, err := json.Marshal(com)
	if err != nil {
		log.Println(err)
		return fmt.Errorf("%v", err)
	}

	_, err = conn.Write(append(c, '\n'))
	if err != nil {
		log.Printf("Ошибка записи: %v", err)
		return fmt.Errorf("ошибка записи: %v", err)
	}
	return nil
}

func main() {

	listenerReady := make(chan net.Listener)
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	s, err := initBD()
	if err != nil {
		log.Fatal(err)
	}
	defer s.Close()
	log.Println("База данных подключена")

	go func() {
		listener, err := net.Listen("tcp", "localhost:8081")
		if err != nil {
			log.Println("ошибка запуска TCP сервера", err)
			return
		}
		listenerReady <- listener
		defer listener.Close()

		for {
			conn, err := listener.Accept()
			if err != nil {
				log.Println(err)
				continue
			}
			go handleConnection(conn, s)
		}
	}()

	go func() {
		serverMux := http.NewServeMux()
		serverMux.HandleFunc("/api/auth/register", corsMiddleware(s.handlerRegister))
		serverMux.HandleFunc("/api/auth/login", corsMiddleware(s.handlerLogin))
		serverMux.HandleFunc("/api/city", corsMiddleware(s.handleGetCity))
		serverMux.HandleFunc("/api/addresses", corsMiddleware(s.handleGetAddresses))
		serverMux.HandleFunc("/api/user/addresses", corsMiddleware(authMiddleware(s.handleUserAddresses)))
		serverMux.HandleFunc("/api/devices", corsMiddleware(s.handleDeviceRequests))
		serverMux.HandleFunc("/api/user/devices", corsMiddleware(authMiddleware(s.handleDeviceRequestsByUser)))
		serverMux.HandleFunc("/api/admin/devices", corsMiddleware(authMiddleware(adminOnly(s.handleAdminDevices))))
		serverMux.HandleFunc("/api/admin/users", corsMiddleware(authMiddleware(adminOnly(s.handleAdminUsers))))
		serverMux.HandleFunc("/api/user/command", corsMiddleware(authMiddleware(s.handleCommand)))

		err := http.ListenAndServe(":8080", serverMux)
		if err != nil {
			log.Println("Ошибка запуска WEB сервера:", err)
			return
		}
	}()

	go func() {
		listener := <-listenerReady
		<-sigChan
		log.Println("Получен сигнал завершения, закрываем соединения...")
		listener.Close()
		s.Close()
		time.Sleep(5 * time.Second)
		os.Exit(0)
	}()

	select {}
}
