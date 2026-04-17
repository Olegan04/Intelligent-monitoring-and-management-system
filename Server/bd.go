package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/sha3"
)

type Storage struct {
	pool *pgxpool.Pool
	ctx  context.Context
}

type Users struct {
	Id         int    `json:"id"`
	FirstName  string `json:"first_name"`
	SecondName string `json:"second_name"`
	Password   string `json:"password"`
	Email      string `json:"email"`
	Status     string `json:"status"`
}

type Addresses struct {
	Id     int    `json:"id"`
	City   string `json:"city"`
	Street string `json:"street"`
	House  string `json:"house"`
	Flat   int    `json:"flat"`
}

type Counters struct {
	Id        int       `json:"id"`
	IdUser    int       `json:"id_user"`
	IdAddress int       `json:"id_address"`
	Type      string    `json:"type"`
	Duration  time.Time `json:"duration"`
	IdModule  int       `json:"id_module"`
	State     string    `json:"state"`
}

type Controls struct {
	IdCounter int       `json:"id_counter"`
	Date      time.Time `json:"date"`
	Value     int       `json:"value"`
}

type Commands struct {
	Id        int       `json:"id"`
	IdCounter int       `json:"id_counter"`
	Action    string    `json:"action"`
	Date      time.Time `json:"date"`
	Status    string    `json:"status"`
}

type NewCounter struct {
	IdCounter int       `json:"id_counter"`
	Type      string    `json:"type"`
	Duration  time.Time `json:"duration"`
	City      string    `json:"city"`
	Street    string    `json:"street"`
	House     string    `json:"house"`
	Flat      int       `json:"flat"`
}

type LocationStats struct {
	Location      string  `json:"location"`
	TotalValue    int     `json:"total_value"`
	AverageValue  float64 `json:"average_value"`
	ReadingsCount int     `json:"readings_count"`
}

type UserDevice struct {
	Id    int    `json:"id"`
	Type  string `json:"type"`
	State string `json:"state"`
}

func (s *Storage) hashSHA3(data []byte) string {
	hash := sha3.Sum256(data)
	return hex.EncodeToString(hash[:])
}

func (s *Storage) createToken(id int, status string) (string, error) {
	token := jwt.NewWithClaims(jwt.SigningMethodHS384, jwt.MapClaims{
		"user_id": id,
		"status":  status,
		"exp":     time.Now().Add(24 * time.Hour).Unix(),
	})
	tokenString, err := token.SignedString(jwtSecret)
	if err != nil {
		return "", fmt.Errorf("Ошибка создания токена: %v", err)
	}
	return tokenString, nil
}

func (s *Storage) parseDateParams(r *http.Request) (time.Time, time.Time, error) {
	query := r.URL.Query()
	from, err := time.Parse("2006-01-02", query.Get("from"))
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("ошибка преобразования данных: %v", err)
	}

	to, err := time.Parse("2006-01-02", query.Get("to"))
	if err != nil {
		return time.Time{}, time.Time{}, fmt.Errorf("ошибка преобразования данных: %v", err)
	}
	to = to.Add(24*time.Hour - time.Second)
	return from, to, nil
}

func (s *Storage) writeAddress(city, street, house string, flat int) (int, error) {
	sql := `
		INSERT INTO "Addresses" (city, street, house, flat)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`
	var id int
	err := s.pool.QueryRow(s.ctx, sql, city, street, house, flat).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Storage) getCities() ([]string, error) {
	sql := `
		SELECT DISTINCT city
		FROM "Addresses"
		ORDER BY city
	`
	rows, err := s.pool.Query(s.ctx, sql)
	if err != nil {
		return nil, fmt.Errorf("ошибка запроса: %w", err)
	}
	defer rows.Close()

	var cities []string
	for rows.Next() {
		var city string
		if err := rows.Scan(&city); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		cities = append(cities, city)
	}
	return cities, nil
}

func (s *Storage) getAddressesByCity(city string) ([]Addresses, error) {
	sql := `
		SELECT id, city, street, house, flat
		FROM "Addresses"
		WHERE city = $1
	`

	rows, err := s.pool.Query(s.ctx, sql, city)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения списка атдресов: %v", err)
	}
	defer rows.Close()

	var addresses []Addresses
	for rows.Next() {
		var addr Addresses
		if err := rows.Scan(&addr.Id, &addr.City, &addr.Street, &addr.House, &addr.Flat); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		addresses = append(addresses, addr)
	}

	return addresses, nil
}

func (s *Storage) getAddressesByUser(idUser int) ([]Addresses, error) {
	sql := `
		SELECT DISTINCT a.id, a.city, a.street, a.house, a.flat
        FROM "Addresses" a
        INNER JOIN "Counters" c ON a.id = c.id_address
        WHERE c.id_user = $1
        ORDER BY a.city, a.street, a.house, a.flat
	`

	rows, err := s.pool.Query(s.ctx, sql, idUser)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения списка атдресов: %v", err)
	}
	defer rows.Close()

	var addresses []Addresses
	for rows.Next() {
		var addr Addresses
		if err := rows.Scan(&addr.Id, &addr.City, &addr.Street, &addr.House, &addr.Flat); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		addresses = append(addresses, addr)
	}

	return addresses, nil
}

func (s *Storage) checkAddressHasDevices(city, street, house string, flat int) (bool, error) {
	sql := `
        SELECT COUNT(*)
        FROM "Counters" c
        JOIN "Addresses" a ON c.id_address = a.id
        WHERE a.city = $1 AND a.street = $2 AND a.house = $3 AND a.flat = $4
    `
	var count int
	err := s.pool.QueryRow(s.ctx, sql, city, street, house, flat).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func (s *Storage) assignAddressToUser(idUSer, idAddress int) error {
	sql := `
		UPDATE "Counters"
		SET id_user = $1
		WHERE id_address = $2
	`
	_, err := s.pool.Exec(s.ctx, sql, idUSer, idAddress)
	if err != nil {
		return fmt.Errorf("ошибка обновления данных: %w", err)
	}
	return nil
}

func (s *Storage) getIdAddress(city, street, house string, flat int) (int, error) {
	sql := `
		SELECT id
		FROM "Addresses"
		WHERE city = $1 and street = $2 and house = $3 and flat = $4
	`
	var id int
	err := s.pool.QueryRow(s.ctx, sql, city, street, house, flat).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, fmt.Errorf("ошибка поиска адреса: %w", err)
	}

	id, err = s.writeAddress(city, street, house, flat)
	if err != nil {
		return id, fmt.Errorf("ошибка создания адреса: %w", err)
	}
	return id, nil
}

func (s *Storage) writeCounter(data NewCounter) error {
	idAddress, err := s.getIdAddress(data.City, data.Street, data.House, data.Flat)
	if err != nil {
		return fmt.Errorf("ошибка получения адреса: %w", err)
	}
	sql := `
		INSERT INTO "Counters" (id, id_address, type, duration)
		VALUES ($1, $2, $3, $4)
	`
	_, err = s.pool.Exec(s.ctx, sql, data.IdCounter, idAddress, data.Type, data.Duration)
	if err != nil {
		return fmt.Errorf("ошибка добавления счетчика: %w", err)
	}
	log.Printf("Счетчик %d добавлен в базу данных", data.IdCounter)
	return nil
}

func (s *Storage) writeNewControl(data Controls) error {
	sql := `
		INSERT INTO "Controls" (id_counter, date, value)
		VALUES ($1, $2, $3)
	`
	_, err := s.pool.Exec(s.ctx, sql, data.IdCounter, data.Date, data.Value)
	if err != nil {
		return fmt.Errorf("ошибка добавления показаний: %w", err)
	}
	return nil
}

func (s *Storage) createCommand(com Commands) (int, error) {
	sql := `
		INSERT INTO "Commands" (id_counter, action, date, status)
		VALUES ($1, $2, $3, $4)
		RETURNING id
	`
	var id int
	err := s.pool.QueryRow(s.ctx, sql, com.IdCounter, com.Action, time.Now(), com.Status).Scan(&id)
	if err != nil {
		return 0, fmt.Errorf("ошибка добавления команды: %w", err)
	}
	return id, nil
}

func (s *Storage) addNewUser(user Users) error {
	sql := `
		INSERT INTO "Users" (first_name, second_name, password, email, status)
		VALUES ($1, $2, $3, $4, $5) 
	`

	_, err := s.pool.Exec(s.ctx, sql, user.FirstName, user.SecondName, user.Password, user.Email, "user")
	if err != nil {
		return fmt.Errorf("ошибка добавления показаний: %w", err)
	}

	return nil
}

func (s *Storage) updateCommandStatus(value string, id int) error {
	sql := `
		UPDATE "Commands"
		SET status = $1
		WHERE id = $2
	`
	_, err := s.pool.Exec(s.ctx, sql, value, id)
	if err != nil {
		return fmt.Errorf("ошибка обновления данных: %w", err)
	}
	return nil
}

func (s *Storage) searchEmail(value string) (bool, error) {
	sql := ` 
		SELECT EXISTS (SELECT 1
		FROM "Users"
		WHERE email = $1)
	`
	var exists bool

	err := s.pool.QueryRow(s.ctx, sql, value).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("ошибка поиска: %w", err)
	}
	return exists, nil
}

func (s *Storage) getUserByEmail(email string) (*Users, error) {
	sql := `
        SELECT id, first_name, second_name, email, password, status 
        FROM "Users"
        WHERE email = $1
    `
	var user Users
	err := s.pool.QueryRow(s.ctx, sql, email).Scan(&user.Id, &user.FirstName, &user.SecondName, &user.Email, &user.Password, &user.Status)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("ошибка поиска: %w", err)
	}
	return &user, nil
}

func (s *Storage) getUsersByStatus(status string) ([]Users, error) {
	sql := `
		SELECT id, first_name, second_name, email
		FROM "Users"
		WHERE status = $1
		ORDER BY id
	`
	rows, err := s.pool.Query(s.ctx, sql, status)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения списка атдресов: %v", err)
	}
	defer rows.Close()

	var users []Users
	for rows.Next() {
		var user Users
		if err := rows.Scan(&user.Id, &user.FirstName, &user.SecondName, &user.Email); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		users = append(users, user)
	}

	return users, nil
}

func (s *Storage) getListDevice(userId, addressId int) ([]UserDevice, error) {
	sql := `
		SELECT id, type, state
		FROM "Counters"
		WHERE id_user = $1 AND id_address = $2
	`
	rows, err := s.pool.Query(s.ctx, sql, userId, addressId)
	if err != nil {
		return nil, fmt.Errorf("Ошибка запроса устройств: %v", err)
	}
	defer rows.Close()

	var devices []UserDevice
	for rows.Next() {
		var device UserDevice
		if err := rows.Scan(&device.Id, &device.Type, &device.State); err != nil {
			log.Println("Ошибка сканирования:", err)
			continue
		}
		devices = append(devices, device)
	}
	return devices, nil
}

func (s *Storage) updateUserStatus(email string, status string) error {
	sql := `
		UPDATE "Users"
		Set status = $2
		WHERE email = $1
	`

	_, err := s.pool.Exec(s.ctx, sql, email, status)
	if err != nil {
		return fmt.Errorf("ошибка обновления данных: %w", err)
	}
	return nil
}

// Показания и статистика
func (s *Storage) getCounterReadings(idCounter int, from, to time.Time) ([]Controls, error) {
	sql := `
		SELECT id_counter, value, date
		FROM "Controls"
		WHERE id_counter = $1 AND date BETWEEN $2 AND $3
		ORDER BY date
	`

	rows, err := s.pool.Query(s.ctx, sql, idCounter, from, to)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения списка атдресов: %v", err)
	}
	defer rows.Close()

	var controls []Controls
	for rows.Next() {
		var control Controls
		if err := rows.Scan(&control.IdCounter, &control.Value, &control.Date); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		controls = append(controls, control)
	}

	return controls, nil
}

func (s *Storage) getCountryStats(typeCounter string, from, to time.Time) ([]LocationStats, error) {
	sql := `
		SELECT 
            a.city,
            COALESCE(SUM(c.value), 0) as total_value,
            COALESCE(AVG(c.value), 0) as avg_value,
            COUNT(c.id_counter) as readings_count
        FROM "Controls" c
        JOIN "Counters" cnt ON c.id_counter = cnt.id
        JOIN "Addresses" a ON cnt.id_address = a.id
        WHERE cnt.type = $1 AND c.date BETWEEN $2 AND $3
        GROUP BY a.city
        ORDER BY a.city
	`
	rows, err := s.pool.Query(s.ctx, sql, typeCounter, from, to)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения статистики по городам: %w", err)
	}
	defer rows.Close()

	var stats []LocationStats
	for rows.Next() {
		var stat LocationStats
		if err := rows.Scan(&stat.Location, &stat.TotalValue, &stat.AverageValue, &stat.ReadingsCount); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		stats = append(stats, stat)
	}
	return stats, nil
}

func (s *Storage) getCityStats(city, typeCounter string, from, to time.Time) ([]LocationStats, error) {
	sql := `
		SELECT 
            a.street,
            COALESCE(SUM(c.value), 0) as total_value,
            COALESCE(AVG(c.value), 0) as avg_value,
            COUNT(c.id_counter) as readings_count
        FROM "Controls" c
        JOIN "Counters" cnt ON c.id_counter = cnt.id
        JOIN "Addresses" a ON cnt.id_address = a.id
        WHERE a.city = $1 AND cnt.type = $2 AND c.date BETWEEN $3 AND $4
        GROUP BY a.street
        ORDER BY a.street
	`
	rows, err := s.pool.Query(s.ctx, sql, city, typeCounter, from, to)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения статистики по городам: %w", err)
	}
	defer rows.Close()

	var stats []LocationStats
	for rows.Next() {
		var stat LocationStats
		if err := rows.Scan(&stat.Location, &stat.TotalValue, &stat.AverageValue, &stat.ReadingsCount); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		stats = append(stats, stat)
	}
	return stats, nil
}

func (s *Storage) getStreetStats(city, street, typeCounter string, from, to time.Time) ([]LocationStats, error) {
	sql := `
		SELECT 
            a.house,
            COALESCE(SUM(c.value), 0) as total_value,
            COALESCE(AVG(c.value), 0) as avg_value,
            COUNT(c.id_counter) as readings_count
        FROM "Controls" c
        JOIN "Counters" cnt ON c.id_counter = cnt.id
        JOIN "Addresses" a ON cnt.id_address = a.id
        WHERE a.city = $1 AND a.street = $2 AND cnt.type = $3 AND c.date BETWEEN $4 AND $5
        GROUP BY a.house
        ORDER BY a.house
	`
	rows, err := s.pool.Query(s.ctx, sql, city, street, typeCounter, from, to)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения статистики по городам: %w", err)
	}
	defer rows.Close()

	var stats []LocationStats
	for rows.Next() {
		var stat LocationStats
		if err := rows.Scan(&stat.Location, &stat.TotalValue, &stat.AverageValue, &stat.ReadingsCount); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		stats = append(stats, stat)
	}
	return stats, nil
}

func (s *Storage) getHouseStats(city, street, house, typeCounter string, from, to time.Time) ([]LocationStats, error) {
	sql := `
		SELECT 
            a.flat,
            COALESCE(SUM(c.value), 0) as total_value,
            COALESCE(AVG(c.value), 0) as avg_value,
            COUNT(c.id_counter) as readings_count
        FROM "Controls" c
        JOIN "Counters" cnt ON c.id_counter = cnt.id
        JOIN "Addresses" a ON cnt.id_address = a.id
        WHERE a.city = $1 AND a.street = $2 AND a.house = $3 AND cnt.type = $4 AND c.date BETWEEN $5 AND $6
        GROUP BY a.flat
        ORDER BY a.flat
	`
	rows, err := s.pool.Query(s.ctx, sql, city, street, house, typeCounter, from, to)
	if err != nil {
		return nil, fmt.Errorf("ошибка получения статистики по городам: %w", err)
	}
	defer rows.Close()

	var stats []LocationStats
	for rows.Next() {
		var stat LocationStats
		if err := rows.Scan(&stat.Location, &stat.TotalValue, &stat.AverageValue, &stat.ReadingsCount); err != nil {
			return nil, fmt.Errorf("ошибка сканирования: %w", err)
		}
		stats = append(stats, stat)
	}
	return stats, nil
}

// Обработчики запросов
func (s *Storage) handlerRegister(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bytesBody, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println(err)
		http.Error(w, "Bad request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var user Users
	if err := json.Unmarshal(bytesBody, &user); err != nil {
		log.Println("Ошибка парсинга JSON: ", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	exists, err := s.searchEmail(user.Email)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if exists {
		http.Error(w, "Email is already in use", http.StatusConflict)
		return
	}

	user.Password = s.hashSHA3([]byte(user.Password))

	if err := s.addNewUser(user); err != nil {
		log.Println("Ошибка добавления пользователя: ", err)
		http.Error(w, "Error adding user", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Storage) handlerLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	email := query.Get("email")
	password := query.Get("password")

	user, err := s.getUserByEmail(email)

	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if user == nil {
		log.Println(err)
		http.Error(w, "User not found", http.StatusNotFound)
		return
	}

	password = s.hashSHA3([]byte(password))
	if password != user.Password {
		log.Println("неверный пароль")
		http.Error(w, "Invalid credentials", http.StatusUnauthorized)
		return
	}

	token, err := s.createToken(user.Id, user.Status)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{
		"token": token,
	})
}

func (s *Storage) handleGetCity(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	cities, err := s.getCities()
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(cities)
}

func (s *Storage) handleGetAddresses(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	city := query.Get("city")

	addr, err := s.getAddressesByCity(city)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(addr)
}

func (s *Storage) handleAddAddress(w http.ResponseWriter, r *http.Request) {
	userIDRaw := r.Context().Value("user_id")
	if userIDRaw == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idUser, ok := userIDRaw.(int)
	if !ok {
		http.Error(w, "Invalid user ID", http.StatusInternalServerError)
		return
	}

	bytesBody, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println(err)
		http.Error(w, "Bad request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var addr Addresses
	if err := json.Unmarshal(bytesBody, &addr); err != nil {
		log.Printf("Ошибка парсинга JSON: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	hasDevices, err := s.checkAddressHasDevices(addr.City, addr.Street, addr.House, addr.Flat)
	if err != nil {
		log.Println("Ошибка проверки устройств:", err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	if !hasDevices {
		http.Error(w, "No meters are registered at this address", http.StatusBadRequest)
		return
	}

	addr.Id, err = s.getIdAddress(addr.City, addr.Street, addr.House, addr.Flat)
	if err != nil {
		log.Println(err)
		http.Error(w, "Error saving address", http.StatusInternalServerError)
		return
	}

	err = s.assignAddressToUser(idUser, addr.Id)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (s *Storage) handleGetAddressesByUser(w http.ResponseWriter, r *http.Request) {
	userIDRaw := r.Context().Value("user_id")
	if userIDRaw == nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	idUser, ok := userIDRaw.(int)
	if !ok {
		http.Error(w, "Invalid user ID", http.StatusInternalServerError)
		return
	}

	addr, err := s.getAddressesByUser(idUser)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(addr)
}

func (s *Storage) handleUserAddresses(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetAddressesByUser(w, r)
	case http.MethodPost:
		s.handleAddAddress(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Storage) handleDeviceRequests(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	query := r.URL.Query()
	typeParam := query.Get("type")
	typeCounter := query.Get("type_counter")
	from, to, err := s.parseDateParams(r)
	if err != nil {
		log.Println(err)
		http.Error(w, "Invalid data", http.StatusBadRequest)
		return
	}

	switch typeParam {
	case "country":
		stats, err := s.getCountryStats(typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "city":
		city := query.Get("city")
		stats, err := s.getCityStats(city, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	default:
		http.Error(w, "Invalid type parameter", http.StatusBadRequest)
	}
}

func (s *Storage) handleDeviceRequestsByUser(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	typeParam := query.Get("type")

	if typeParam == "list" {
		userIDRaw := r.Context().Value("user_id")
		if userIDRaw == nil {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}

		userId, ok := userIDRaw.(int)
		if !ok {
			http.Error(w, "Invalid user ID", http.StatusInternalServerError)
			return
		}

		addressIDStr := query.Get("address_id")
		if addressIDStr == "" {
			http.Error(w, "Missing address_id parameter", http.StatusBadRequest)
			return
		}

		addressId, err := strconv.Atoi(addressIDStr)
		if err != nil {
			http.Error(w, "Invalid address_id", http.StatusBadRequest)
			return
		}

		devices, err := s.getListDevice(userId, addressId)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(devices)
		return
	}

	from, to, err := s.parseDateParams(r)
	if err != nil {
		log.Println(err)
		http.Error(w, "Invalid data", http.StatusBadRequest)
		return
	}

	switch typeParam {
	case "counter":
		idCounter, err := strconv.Atoi(query.Get("id_counter"))
		if err != nil {
			log.Println("ошибка преобразования данных", err)
			http.Error(w, "Invalid data", http.StatusBadRequest)
			return
		}

		controls, err := s.getCounterReadings(idCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(controls)

	case "country":
		typeCounter := query.Get("type_counter")
		stats, err := s.getCountryStats(typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "city":
		typeCounter := query.Get("type_counter")
		city := query.Get("city")
		stats, err := s.getCityStats(city, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "street":
		typeCounter := query.Get("type_counter")
		city := query.Get("city")
		street := query.Get("street")

		stats, err := s.getStreetStats(city, street, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	default:
		http.Error(w, "Invalid type parameter", http.StatusBadRequest)
	}
}

func (s *Storage) handleDeviceRequestsByAdmin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	query := r.URL.Query()
	typeParam := query.Get("type")
	from, to, err := s.parseDateParams(r)
	if err != nil {
		log.Println(err)
		http.Error(w, "Invalid data", http.StatusBadRequest)
		return
	}

	switch typeParam {
	case "counter":
		idCounter, err := strconv.Atoi(query.Get("id_counter"))
		if err != nil {
			log.Println("ошибка преобразования данных", err)
			http.Error(w, "Invalid data", http.StatusBadRequest)
			return
		}

		controls, err := s.getCounterReadings(idCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(controls)

	case "country":
		typeCounter := query.Get("type_counter")
		stats, err := s.getCountryStats(typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "city":
		typeCounter := query.Get("type_counter")
		city := query.Get("city")
		stats, err := s.getCityStats(city, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "street":
		typeCounter := query.Get("type_counter")
		city := query.Get("city")
		street := query.Get("street")

		stats, err := s.getStreetStats(city, street, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)

	case "house":
		typeCounter := query.Get("type_counter")
		city := query.Get("city")
		street := query.Get("street")
		house := query.Get("house")

		stats, err := s.getHouseStats(city, street, house, typeCounter, from, to)
		if err != nil {
			log.Println(err)
			http.Error(w, "Internal server error", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(stats)
	}
}

func (s *Storage) handleAddDevice(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	bytesBody, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println(err)
		http.Error(w, "Bad request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var data NewCounter
	if err := json.Unmarshal(bytesBody, &data); err != nil {
		log.Printf("Ошибка парсинга JSON: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	err = s.writeCounter(data)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Storage) handleAdminDevices(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleDeviceRequestsByAdmin(w, r)
	case http.MethodPost:
		s.handleAddDevice(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Storage) handleGetUsers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	status := query.Get("status")

	var users []Users
	users, err := s.getUsersByStatus(status)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(users)
}

func (s *Storage) handleUpdateUserStatus(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	email := query.Get("email")
	status := query.Get("status")

	err := s.updateUserStatus(email, status)
	if err != nil {
		log.Println(err)
		http.Error(w, "Internal server error", http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusOK)
}

func (s *Storage) handleAdminUsers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		s.handleGetUsers(w, r)
	case http.MethodPost:
		s.handleUpdateUserStatus(w, r)
	default:
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	}
}

func (s *Storage) handleCommand(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	bytesBody, err := io.ReadAll(r.Body)
	if err != nil {
		log.Println(err)
		http.Error(w, "Bad request body", http.StatusBadRequest)
		return
	}
	defer r.Body.Close()

	var command Commands
	if err := json.Unmarshal(bytesBody, &command); err != nil {
		log.Printf("Ошибка парсинга JSON: %v", err)
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	id, err := s.createCommand(command)
	if err != nil {
		log.Println(err)
		return
	}
	command.Id = id
	err = sendingCommand(command)
	if err != nil {
		http.Error(w, "Error command execution", http.StatusInternalServerError)
		err = s.updateCommandStatus("failed", id)
		if err != nil {
			log.Println("Ошибка обновления данных:", err)
		}
	}
	w.WriteHeader(http.StatusOK)
}

// Инициализация БД
func initBD() (*Storage, error) {
	ctx := context.Background()
	pool, err := pgxpool.New(ctx,
		"postgres://postgres:dataBase@localhost:5432/Counters-IOT")
	if err != nil {
		return nil, fmt.Errorf("ошибка подключения: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		return nil, fmt.Errorf("ошибка ping: %w", err)
	}
	return &Storage{
		pool: pool,
		ctx:  ctx,
	}, nil
}

func (s *Storage) Close() {
	s.pool.Close()
}
