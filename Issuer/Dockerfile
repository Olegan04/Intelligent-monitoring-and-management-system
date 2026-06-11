FROM golang:1.25-alpine AS builder

WORKDIR /app

COPY go.mod ./
RUN go mod download

COPY *.go ./

RUN CGO_ENABLED=0 GOOS=linux go build -o counter .

FROM alpine:3.21

WORKDIR /app

# Копируем скомпилированный бинарник
COPY --from=builder /app/counter .

# Копируем файлы идентификаторов модулей
COPY module1.id module2.id module3.id ./

# Копируем файлы с сохранёнными состояниями (твои готовые JSON)
COPY module1_state.json module2_state.json module3_state.json ./

# Запускаем имитатор
CMD ["./counter"]