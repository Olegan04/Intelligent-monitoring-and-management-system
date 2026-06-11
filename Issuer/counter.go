package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

type ListDivases struct {
	Id      int    `json:"id"`
	Text    string `json:"text"`
	Devices []int  `json:"devices"`
}

type Control struct {
	Id        int       `json:"id_counter"`
	Value     int       `json:"value"`
	Timestamp time.Time `json:"date"`
}

type Commands struct {
	IdCommand int    `json:"id_command"`
	IdCounter int    `json:"id_counter"`
	Action    string `json:"action"`
}

type Result struct {
	IdCommand int    `json:"id_command"`
	Status    string `json:"status"`
}

type Message struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

type CounterState struct {
	Counters map[int]int `json:"counters"`
}

var (
	rng           = rand.New(rand.NewSource(time.Now().UnixNano()))
	stoppedDivise = make(map[int]bool)
	mu            sync.RWMutex
	fileMutex     sync.Mutex
)

func getModuleID(n int) int {
	name := "module" + strconv.Itoa(n) + ".id"
	data, err := os.ReadFile(name)
	if err == nil {
		id, err := strconv.Atoi(string(data))
		if err != nil {
			log.Fatalln(err)
		}
		return id
	}

	file, _ := os.Create(name)
	file.WriteString(strconv.Itoa(n))
	return n
}

func saveCounterState(moduleId int, values map[int]int) {
	fileMutex.Lock()
	defer fileMutex.Unlock()

	filename := fmt.Sprintf("module%d_state.json", moduleId)
	existingState := make(map[int]int)
	if data, err := os.ReadFile(filename); err == nil {
		var state CounterState
		if json.Unmarshal(data, &state) == nil && state.Counters != nil {
			existingState = state.Counters
		}
	}

	for k, v := range values {
		existingState[k] = v
	}

	data, err := json.MarshalIndent(CounterState{Counters: existingState}, "", "  ")
	if err != nil {
		log.Printf("Ошибка сериализации состояния: %v", err)
		return
	}
	err = os.WriteFile(filename, data, 0644)
	if err != nil {
		log.Printf("Ошибка сохранения состояния в файл %s: %v", filename, err)
	} else {
		log.Printf("Состояние счётчиков сохранено в %s", filename)
	}
}

func loadCounterState(moduleId int, deviceIds []int) map[int]int {
	filename := fmt.Sprintf("module%d_state.json", moduleId)
	data, err := os.ReadFile(filename)
	if err != nil {
		log.Printf("Файл состояния %s не найден, начинаем с нуля", filename)
		return make(map[int]int)
	}

	var state CounterState
	if err := json.Unmarshal(data, &state); err != nil {
		log.Printf("Ошибка парсинга файла состояния %s: %v", filename, err)
		return make(map[int]int)
	}

	result := state.Counters
	if result == nil {
		result = make(map[int]int)
	}
	for _, id := range deviceIds {
		if _, exists := result[id]; !exists {
			result[id] = 0
			log.Printf("Счётчик %d не найден в сохранённом состоянии, инициализирован нулём", id)
		}
	}
	log.Printf("Состояние счётчиков загружено из %s", filename)
	return result
}

func parseNumbers(s string) ([]int, error) {
	parts := strings.Fields(s)
	nums := make([]int, 0, len(parts))
	for _, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil {
			return nil, fmt.Errorf("не удалось преобразовать '%s' в число: %w", part, err)
		}
		nums = append(nums, n)
	}
	return nums, nil
}

func handleCommand(command Commands) {
	mu.Lock()
	defer mu.Unlock()
	switch command.Action {
	case "on":
		delete(stoppedDivise, command.IdCounter)
	case "off":
		stoppedDivise[command.IdCounter] = true
	}
}

func createMessage(typeMessage string, data interface{}) ([]byte, error) {
	d, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("ошибка маршалинга: %w", err)
	}
	message := Message{
		Type: typeMessage,
		Data: d,
	}
	msg, err := json.Marshal(message)
	if err != nil {
		return nil, fmt.Errorf("ошибка маршалинга: %w", err)
	}
	return msg, nil
}

func writeOnServer(conn net.Conn, control <-chan Control, done <-chan struct{}, disconnect chan<- struct{}) {
	for {
		select {
		case <-done:
			return
		case c, ok := <-control:
			if !ok {
				return
			}
			str, err := createMessage("control", c)
			if err != nil {
				log.Println(err)
				continue
			}
			_, err = conn.Write(append(str, '\n'))
			if err != nil {
				log.Printf("Ошибка записи: %v", err)
				select {
				case disconnect <- struct{}{}:
				default:
				}
				return
			}
			time.Sleep(time.Millisecond * 50)
		}
	}
}

func readOnServer(conn net.Conn, done <-chan struct{}, disconnect chan<- struct{}) {
	reader := bufio.NewReader(conn)
	for {
		select {
		case <-done:
			return
		default:
			line, err := reader.ReadBytes('\n')
			if err != nil {
				log.Println("Ошибка чтения, соединение разорвано:", err)
				select {
				case disconnect <- struct{}{}:
				default:
				}
				return
			}
			var command Commands
			if err := json.Unmarshal(line, &command); err != nil {
				log.Println("Ошибка преобразования:", err)
				continue
			}
			handleCommand(command)
			result := Result{
				IdCommand: command.IdCommand,
				Status:    "executed",
			}
			mes, err := createMessage("result", result)
			if err != nil {
				log.Println(err)
				continue
			}
			_, err = conn.Write(append(mes, '\n'))
			if err != nil {
				log.Printf("Ошибка записи: %v", err)
				return
			}
		}
	}
}

func randomInt(min, max int) int {
	return rng.Intn(max-min+1) + min
}

func isStopped(deviceId int) bool {
	mu.RLock()
	defer mu.RUnlock()
	return stoppedDivise[deviceId]
}

func counter(id, moduleId int, message chan Control, currentValue int, done <-chan struct{}) {
	value := currentValue
	for {
		select {
		case <-done:
			return
		default:
			if isStopped(id) {
				time.Sleep(time.Minute)
				continue
			}
			value += randomInt(100, 120)
			msg := Control{
				Id:        id,
				Value:     value,
				Timestamp: time.Now(),
			}
			select {
			case message <- msg:
			case <-done:
				return
			}
			go saveCounterState(moduleId, map[int]int{id: value})
			time.Sleep(time.Minute * 5)
		}
	}
}

func connectWithRetry(serverAddr string) net.Conn {
	for {
		conn, err := net.Dial("tcp", serverAddr)
		if err == nil {
			log.Println("Подключено к серверу", serverAddr)
			return conn
		}
		log.Printf("Ошибка подключения к %s: %v. Повтор через 5 минут...", serverAddr, err)
		time.Sleep(1 * time.Minute)
	}
}

func sendRegistration(conn net.Conn, moduleId int, devices []int) error {
	list := ListDivases{
		Id:      moduleId,
		Text:    "Подключенные устройства",
		Devices: devices,
	}
	l, err := json.Marshal(list)
	if err != nil {
		return err
	}
	mes := Message{
		Type: "registration",
		Data: l,
	}
	str, err := json.Marshal(mes)
	if err != nil {
		return err
	}
	_, err = conn.Write(append(str, '\n'))
	return err
}

func run(moduleId int, devices []int, savedValues map[int]int, sigChan chan os.Signal) {
	serverHost := os.Getenv("SERVER_HOST")
	if serverHost == "" {
		serverHost = "localhost"
	}
	serverPort := os.Getenv("SERVER_PORT")
	if serverPort == "" {
		serverPort = "8081"
	}

	for {
		// Загружаем свежие сохранённые показатели
		currentValues := loadCounterState(moduleId, devices)
		for id, val := range savedValues {
			if _, ok := currentValues[id]; !ok {
				currentValues[id] = val
			}
		}

		conn := connectWithRetry(serverHost + ":" + serverPort)
		messageChan := make(chan Control, len(devices)*2+1)
		doneChan := make(chan struct{})
		disconnect := make(chan struct{})

		if err := sendRegistration(conn, moduleId, devices); err != nil {
			log.Printf("Ошибка регистрации: %v, переподключение...", err)
			conn.Close()
			time.Sleep(5 * time.Second)
			continue
		}
		log.Println("Регистрация на сервере выполнена")

		go writeOnServer(conn, messageChan, doneChan, disconnect)
		go readOnServer(conn, doneChan, disconnect)
		for _, id := range devices {
			go counter(id, moduleId, messageChan, currentValues[id], doneChan)
		}

		select {
		case <-sigChan:
			log.Println("Получен сигнал завершения, закрываем соединения...")
			close(doneChan)
			close(messageChan)
			conn.Close()
			return
		case <-disconnect:
			log.Println("Соединение потеряно, переподключаемся...")
			close(doneChan)
			close(messageChan)
			conn.Close()
			time.Sleep(2 * time.Second)
			continue
		}
	}
}

func main() {
	numberStr := os.Getenv("COUNTER_NUMBER")
	if numberStr == "" {
		log.Fatal("Переменная окружения COUNTER_NUMBER не задана")
	}
	number, err := strconv.Atoi(strings.TrimSpace(numberStr))
	if err != nil {
		log.Fatalf("Неверный номер имитатора: %v", err)
	}
	listIdStr := os.Getenv("COUNTER_IDS")
	if listIdStr == "" {
		log.Fatal("Переменная окружения COUNTER_IDS не задана")
	}
	listId := strings.TrimSpace(listIdStr)

	ides, err := parseNumbers(listId)
	if err != nil {
		log.Fatal(err)
	}

	moduleId := getModuleID(number)
	savedValues := loadCounterState(moduleId, ides)

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT)

	run(moduleId, ides, savedValues, sigChan)
}
