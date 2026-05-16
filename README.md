# Math Board Archive

학원 칠판 필기 사진을 날짜별로 업로드하고 갤러리로 보는 웹앱입니다.

## 로컬 실행

```cmd
cd /d D:\math
node server.js
```

브라우저에서 `http://localhost:4004`로 접속합니다.

## 환경 변수

실제 비밀번호는 `.env`에만 저장하고 GitHub에는 올리지 않습니다.
새 환경에서는 `.env.example`을 복사해서 `.env`를 만든 뒤 값을 채우면 됩니다.

```env
PORT=4004
ADMIN_ID=your-id
ADMIN_PASSWORD=your-password
TOKEN_SECRET=long-random-secret
```

## 저장 데이터

- 사진 파일: `public/uploads/`
- 로컬 DB: `data/db.json`

두 경로는 GitHub에 올리지 않습니다.
