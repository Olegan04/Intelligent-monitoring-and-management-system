// js/auth.js

document.addEventListener('DOMContentLoaded', () => {
    // ТОЛЬКО для страницы dashboard.html проверяем токен
    if (window.location.pathname.includes('dashboard.html')) {
        if (!authToken) {
            window.location.href = 'index.html';
            return;
        }
        return; // На дашборде не ищем формы входа
    }
    
    // ========== КОД НИЖЕ ВЫПОЛНЯЕТСЯ ТОЛЬКО НА index.html ==========
    
    // Переключение табов
    const loginTab = document.getElementById('loginTab');
    const registerTab = document.getElementById('registerTab');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');
    
    if (loginTab && registerTab && loginForm && registerForm) {
        loginTab.addEventListener('click', () => {
            loginTab.classList.add('active');
            registerTab.classList.remove('active');
            loginForm.classList.add('active');
            registerForm.classList.remove('active');
        });
        
        registerTab.addEventListener('click', () => {
            registerTab.classList.add('active');
            loginTab.classList.remove('active');
            registerForm.classList.add('active');
            loginForm.classList.remove('active');
        });
    }
    
    // Регистрация
    const registerFormElement = document.getElementById('registerForm');
    if (registerFormElement) {
        registerFormElement.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const firstName = document.getElementById('regFirstName')?.value.trim();
            const secondName = document.getElementById('regSecondName')?.value.trim();
            const email = document.getElementById('regEmail')?.value.trim();
            const password = document.getElementById('regPassword')?.value;
            const confirmPassword = document.getElementById('regConfirmPassword')?.value;
            
            if (!firstName || !secondName || !email || !password) {
                showMessage('authMessage', 'Заполните все поля', true);
                return;
            }
            
            if (password !== confirmPassword) {
                showMessage('authMessage', 'Пароли не совпадают', true);
                return;
            }
            
            if (password.length < 6) {
                showMessage('authMessage', 'Пароль должен быть не менее 6 символов', true);
                return;
            }
            
            const userData = {
                first_name: firstName,
                second_name: secondName,
                email: email,
                password: password
            };
            
            try {
                const response = await fetch(`${API_BASE}/api/auth/register`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(userData)
                });
                
                if (response.ok) {
                    showMessage('authMessage', 'Регистрация успешна! Теперь войдите', false);
                    registerFormElement.reset();
                    if (loginTab) loginTab.click();
                } else if (response.status === 409) {
                    const text = await response.text();
                    showMessage('authMessage', text || 'Email уже используется', true);
                } else {
                    showMessage('authMessage', 'Ошибка регистрации. Попробуйте позже', true);
                }
            } catch (error) {
                console.error('Register error:', error);
                showMessage('authMessage', 'Ошибка соединения с сервером', true);
            }
        });
    }
    
    // Логин
    const loginFormElement = document.getElementById('loginForm');
    if (loginFormElement) {
        loginFormElement.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('loginEmail')?.value.trim();
            const password = document.getElementById('loginPassword')?.value;
            
            if (!email || !password) {
                showMessage('authMessage', 'Введите email и пароль', true);
                return;
            }
            
            try {
                const response = await fetch(`${API_BASE}/api/auth/login?email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
                
                if (response.ok) {
                    const data = await response.json();
                    if (data.token) {
                        localStorage.setItem('token', data.token);
                        window.location.href = 'dashboard.html';
                    } else {
                        showMessage('authMessage', 'Неверный ответ сервера', true);
                    }
                } else if (response.status === 401) {
                    showMessage('authMessage', 'Неверный email или пароль', true);
                } else if (response.status === 404) {
                    showMessage('authMessage', 'Пользователь не найден', true);
                } else {
                    showMessage('authMessage', 'Ошибка входа. Попробуйте позже', true);
                }
            } catch (error) {
                console.error('Login error:', error);
                showMessage('authMessage', 'Ошибка соединения с сервером', true);
            }
        });
    }
});