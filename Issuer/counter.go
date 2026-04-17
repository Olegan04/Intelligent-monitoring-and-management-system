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

var (
	rng           = rand.New(rand.NewSource(time.Now().UnixNano()))
	stoppedDivise = make(map[int]bool)
	mu            sync.RWMutex
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

func writeOnServer(conn net.Conn, control <-chan Control) {
	for c := range control {
		str, err := createMessage("control", c)
		if err != nil {
			log.Println(err)
			continue
		}
		_, err = conn.Write(append(str, '\n'))
		if err != nil {
			log.Printf("Ошибка записи: %v", err)
			continue
		}
		time.Sleep(time.Millisecond * 50)
	}
}

func readOnServer(conn net.Conn) {
	reader := bufio.NewReader(conn)

	for {
		line, err := reader.ReadBytes('\n')
		if err != nil {
			log.Println("Ошибка чтения: ", err)
			continue
		}

		var command Commands
		if err := json.Unmarshal(line, &command); err != nil {
			log.Println("Ошибка преобразования: ", err)
			continue
		}
		handleCommand(command)
		result := Result{
			IdCommand: command.IdCommand,
			Status:    "executed",
		}
		mes, err := createMessage("result", result)
		_, err = conn.Write(append(mes, '\n'))
		if err != nil {
			log.Printf("Ошибка записи: %v", err)
			continue
		}
	}
}

func randomInt(min, max int) int {
	return rng.Intn(max-min+1) + min
}

func isStopped(deviseId int) bool {
	mu.RLock()
	defer mu.RUnlock()
	return stoppedDivise[deviseId]
}

func counter(id int, message chan Control) {
	value := 0
	for {
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
		message <- msg
		time.Sleep(time.Minute * 5)
	}
}

func main() {
	reader := bufio.NewReader(os.Stdin)

	fmt.Println("Введите количество установленных счетчиков")
	nStr, _ := reader.ReadString('\n')
	n, _ := strconv.Atoi(strings.TrimSpace(nStr))

	fmt.Println("Введите id счетчиков через пробел")
	listIdStr, _ := reader.ReadString('\n')
	listId := strings.TrimSpace(listIdStr)

	fmt.Println("Введите какой по счету вы запускаете имитатор")
	numberStr, _ := reader.ReadString('\n')
	number, _ := strconv.Atoi(strings.TrimSpace(numberStr))

	ides, err := parseNumbers(listId)
	if err != nil {
		log.Fatal(err)
	}

	conn, err := net.Dial("tcp", "localhost:8081")
	if err != nil {
		log.Println(err)
	}
	defer conn.Close()

	list := ListDivases{
		Id:      getModuleID(number),
		Text:    "Подключенные устройства",
		Devices: ides,
	}

	l, err := json.Marshal(list)
	if err != nil {
		log.Println(err)
		return
	}
	mes := Message{
		Type: "registration",
		Data: l,
	}
	str, e := json.Marshal(mes)
	if e != nil {
		log.Println(e)
	}
	_, err = conn.Write(append(str, '\n'))
	if err != nil {
		log.Printf("Ошибка записи: %v", err)
	}

	message := make(chan Control, n*2+1)
	defer close(message)

	go writeOnServer(conn, message)
	go readOnServer(conn)
	for i := 0; i < n; i++ {
		go counter(ides[i], message)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		log.Println("Получен сигнал завершения, закрываем соединения...")
		close(message)
		conn.Close()
		os.Exit(0)
	}()

	select {}
}
