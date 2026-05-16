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

## 온라인 배포

GitHub는 코드 저장소이고, 실제 웹 배포는 Vercel에서 합니다.
Vercel에서는 로컬 파일 저장을 사용할 수 없으므로 Firebase 모드를 켭니다.

### Vercel 환경 변수

Vercel 프로젝트의 Settings > Environment Variables에 아래 값을 추가합니다.

```env
ADMIN_ID=your-id
ADMIN_PASSWORD=your-password
TOKEN_SECRET=long-random-secret
USE_FIREBASE=true
FIREBASE_STORAGE_BUCKET=your-project-id.firebasestorage.app
FIREBASE_SERVICE_ACCOUNT={"type":"service_account",...}
```

`FIREBASE_SERVICE_ACCOUNT`에는 `firebase-key.json`의 전체 JSON을 한 줄로 넣습니다.
이 값은 GitHub에 올리지 않습니다.

Firebase Storage 버킷 이름은 Firebase 콘솔의 Storage 화면에서 확인합니다.
