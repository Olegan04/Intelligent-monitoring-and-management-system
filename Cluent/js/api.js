// js/api.js

// Конфигурация
const API_BASE = 'http://localhost:8080';
let authToken = localStorage.getItem('token');

// ========== ПУБЛИЧНЫЕ ЗАПРОСЫ ==========

async function getCities() {
    const response = await fetch(`${API_BASE}/api/city`);
    if (!response.ok) throw new Error('Ошибка загрузки городов');
    return response.json();
}

async function getAddressesByCity(city) {
    const response = await fetch(`${API_BASE}/api/addresses?city=${encodeURIComponent(city)}`);
    if (!response.ok) throw new Error('Ошибка загрузки адресов');
    return response.json();
}

async function getPublicStats(type, typeCounter, params = {}) {
    let url = `${API_BASE}/api/devices?type=${type}&type_counter=${encodeURIComponent(typeCounter)}`;
    if (params.from) url += `&from=${params.from}`;
    if (params.to) url += `&to=${params.to}`;
    if (params.city) url += `&city=${encodeURIComponent(params.city)}`;
    
    console.log('Запрос статистики:', url); // Для отладки
    
    const response = await fetch(url);
    if (!response.ok) throw new Error('Ошибка загрузки статистики');
    return response.json();
}

// ========== ЗАПРОСЫ С АВТОРИЗАЦИЕЙ ==========

async function apiRequest(endpoint, method = 'GET', body = null, requiresAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (requiresAuth && authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
    }
    
    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);
    
    const url = `${API_BASE}${endpoint}`;
    
    const response = await fetch(url, options);
    
    if (response.status === 401) {
        localStorage.removeItem('token');
        window.location.href = 'index.html';
        return null;
    }
    
    if (response.status === 204) {
        return { success: true };
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return await response.json();
    }
    
    return { success: response.ok };
}

async function getUserStats(type, params = {}) {
    let url = `/api/user/devices?type=${type}`;
    if (params.from) url += `&from=${params.from}`;
    if (params.to) url += `&to=${params.to}`;
    if (params.type_counter) url += `&type_counter=${encodeURIComponent(params.type_counter)}`;
    if (params.city) url += `&city=${encodeURIComponent(params.city)}`;
    if (params.street) url += `&street=${encodeURIComponent(params.street)}`;
    if (params.id_counter) url += `&id_counter=${params.id_counter}`;
    
    return apiRequest(url, 'GET');
}

async function getAdminStats(type, params = {}) {
    let url = `/api/admin/devices?type=${type}`;
    if (params.from) url += `&from=${params.from}`;
    if (params.to) url += `&to=${params.to}`;
    if (params.type_counter) url += `&type_counter=${encodeURIComponent(params.type_counter)}`;
    if (params.city) url += `&city=${encodeURIComponent(params.city)}`;
    if (params.street) url += `&street=${encodeURIComponent(params.street)}`;
    if (params.house) url += `&house=${encodeURIComponent(params.house)}`;
    if (params.id_counter) url += `&id_counter=${params.id_counter}`;
    
    return apiRequest(url, 'GET');
}

async function register(userData) {
    return apiRequest('/api/auth/register', 'POST', userData, false);
}

async function login(email, password) {
    const data = await apiRequest(`/api/auth/login?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`, 'POST', null, false);
    if (data && data.token) {
        authToken = data.token;
        localStorage.setItem('token', authToken);
        return true;
    }
    return false;
}

function logout() {
    localStorage.removeItem('token');
    window.location.href = './index.html';
}

async function getUserAddresses() {
    return apiRequest('/api/user/addresses', 'GET');
}

async function addAddress(address) {
    const response = await fetch(`${API_BASE}/api/user/addresses`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`
        },
        body: JSON.stringify(address)
    });
    
    if (!response.ok) {
        let errorMessage = 'Ошибка добавления адреса';
        try {
            const errorText = await response.text();
            if (errorText) errorMessage = errorText;
        } catch (e) {
            // игнорируем
        }
        throw new Error(errorMessage);
    }
    
    return response.ok;
}

async function getUserDevicesByAddressId(addressId) {
    const url = `/api/user/devices?type=list&address_id=${addressId}`;
    return apiRequest(url, 'GET');
}

// Получить показания конкретного счётчика за период
async function getCounterReadings(counterId, from, to) {
    const url = `/api/user/devices?type=counter&id_counter=${counterId}&from=${from}&to=${to}`;
    return apiRequest(url, 'GET');
}

// Получить статистику (уже есть getUserStats, но можно использовать напрямую)
async function getUserStatistics(type, params = {}) {
    let url = `/api/user/devices?type=${type}`;
    if (params.from) url += `&from=${params.from}`;
    if (params.to) url += `&to=${params.to}`;
    if (params.type_counter) url += `&type_counter=${encodeURIComponent(params.type_counter)}`;
    if (params.city) url += `&city=${encodeURIComponent(params.city)}`;
    if (params.street) url += `&street=${encodeURIComponent(params.street)}`;
    if (params.id_counter) url += `&id_counter=${params.id_counter}`;
    if (params.address_id) url += `&address_id=${params.address_id}`;
    
    return apiRequest(url, 'GET');
}

async function addDevice(device) {
    return apiRequest('/api/admin/devices', 'POST', device);
}

async function sendCommand(command) {
    return apiRequest('/api/user/command', 'POST', command);
}

async function getUsers(status) {
    return apiRequest(`/api/admin/users?status=${status}`, 'GET');
}

async function updateUserStatus(email, status) {
    return apiRequest(`/api/admin/users?email=${encodeURIComponent(email)}&status=${status}`, 'POST');
}

function showMessage(elementId, message, isError = true) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = message;
        el.className = isError ? 'auth-message error' : 'auth-message success';
        setTimeout(() => {
            el.className = 'auth-message';
            el.textContent = '';
        }, 4000);
    }
}