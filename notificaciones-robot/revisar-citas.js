// Este script lo ejecuta GitHub Actions cada cierto tiempo (ver el archivo
// .github/workflows/revisar-citas.yml). Revisa si hay pacientes cuya
// próxima cita está por comenzar, y si es así, manda una notificación push
// al celular del doctor/a (o de todo el equipo, si el paciente pertenece a
// una clínica compartida).
//
// No modifica nada más de la app: solo LEE pacientes y config, y ESCRIBE
// una marca en el paciente para no avisar dos veces por la misma cita.
//
// A propósito, este script NO usa consultas de "grupo de colección"
// (collectionGroup): esas requieren crear un índice especial en Firestore
// que puede ser confuso de configurar a mano. En su lugar, revisa clínica
// por clínica y usuario por usuario, consultando cada colección de
// pacientes por separado — más lento con MUCHOS usuarios, pero no necesita
// ninguna configuración extra en Firestore.

const admin = require("firebase-admin");

// La llave de servicio viene de un "secreto" de GitHub (nunca se sube al
// repositorio en texto plano). Ver las instrucciones para configurarlo.
const crudo = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
let serviceAccount;
try {
  serviceAccount = JSON.parse(crudo);
} catch (e) {
  console.error("❌ El secreto FIREBASE_SERVICE_ACCOUNT_JSON no se pudo leer como JSON válido.");
  console.error("Longitud recibida (caracteres):", crudo.length);
  console.error("¿Empieza con '{'?:", crudo.trimStart().startsWith("{"));
  console.error("¿Termina con '}'?:", crudo.trimEnd().endsWith("}"));
  console.error("Mensaje del error de parseo:", e.message);
  process.exit(1);
}
if (!serviceAccount.private_key || !serviceAccount.client_email || !serviceAccount.project_id) {
  console.error("❌ El JSON se leyó, pero le faltan campos esperados (private_key, client_email o project_id).");
  console.error("Campos presentes:", Object.keys(serviceAccount).join(", "));
  process.exit(1);
}
console.log("✅ Llave de servicio leída correctamente para el proyecto:", serviceAccount.project_id);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const messaging = admin.messaging();

// Ventana de aviso: se notifica cuando falten entre 0 y 30 minutos para la
// cita (una sola vez por cita, gracias a la marca que se guarda después).
const MINUTOS_VENTANA = 30;

function hoyComoTexto() {
  // Igual que con la hora de la cita: se calcula "qué día es hoy" según la
  // hora de Ecuador (UTC-5), no la del servidor donde corre el robot — para
  // no confundirse cerca de la medianoche.
  const ahoraEcuador = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const y = ahoraEcuador.getUTCFullYear();
  const m = String(ahoraEcuador.getUTCMonth() + 1).padStart(2, "0");
  const d = String(ahoraEcuador.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function minutosHastaLaCita(fechaTexto, horaTexto) {
  const [anio, mes, dia] = fechaTexto.split("-").map(Number);
  const [hora, minuto] = horaTexto.split(":").map(Number);
  // La app está pensada para clínicas en Ecuador (UTC-5, sin horario de
  // verano). El robot corre en un servidor que usa hora UTC, así que se
  // arma el momento de la cita directamente en UTC sumándole 5 horas a la
  // hora de Ecuador que se guardó — así el resultado es correcto sin
  // importar en qué zona horaria esté físicamente el servidor del robot.
  const momentoCitaUTC = Date.UTC(anio, mes - 1, dia, hora + 5, minuto, 0);
  const ahoraUTC = Date.now();
  return Math.round((momentoCitaUTC - ahoraUTC) / 60000);
}

async function enviarSiCorresponde(patientDoc, hoy, tokens, etiqueta) {
  const paciente = patientDoc.data();

  if (!paciente.proximaVisitaHora) return false;
  if (paciente.eliminadoEn) return false;

  // La marca de "ya avisado" incluye la fecha Y la hora exactas de la cita
  // (no solo el día): si el paciente reprograma la cita a otra hora, o
  // incluso a otro día, esto cambia y el aviso se puede volver a mandar.
  const marcaDeEstaCita = `${paciente.proximaVisita} ${paciente.proximaVisitaHora}`;
  if (paciente.recordatorioEnviadoPara === marcaDeEstaCita) return false;

  const minutosRestantes = minutosHastaLaCita(paciente.proximaVisita, paciente.proximaVisitaHora);
  if (minutosRestantes < 0 || minutosRestantes > MINUTOS_VENTANA) return false;

  if (!tokens || tokens.length === 0) {
    console.log(`[${etiqueta}] Paciente ${paciente.nombre}: sin dispositivos con notificaciones activadas, se omite.`);
    return false;
  }

  // Se manda solo como "data" (no como "notification"): si se manda como
  // "notification", el navegador la muestra solo automáticamente, y como
  // nuestro propio código TAMBIÉN la muestra a mano, salían dos veces. Con
  // solo "data", el control es 100% de nuestro código, sin duplicar.
  const mensaje = {
    data: {
      title: `Cita en ${minutosRestantes <= 1 ? "un momento" : minutosRestantes + " min"}: ${paciente.nombre}`,
      body: paciente.propietario ? `Propietario: ${paciente.propietario}` : "Revisa la ficha del paciente.",
      patientId: String(paciente.id || patientDoc.id),
      // Foto de perfil del paciente (si tiene). Se manda como texto vacío
      // si no hay foto, ya que los mensajes "data" de FCM solo aceptan
      // valores de texto, nunca "undefined" o "null".
      foto: paciente.foto || "",
    },
    tokens,
  };

  try {
    const resultado = await messaging.sendEachForMulticast(mensaje);
    console.log(`[${etiqueta}] Notificación enviada para ${paciente.nombre}: ${resultado.successCount} éxito(s), ${resultado.failureCount} fallo(s).`);
  } catch (e) {
    console.error(`[${etiqueta}] Error enviando notificación para ${paciente.nombre}:`, e.message);
  }

  await patientDoc.ref.update({ recordatorioEnviadoPara: marcaDeEstaCita });
  return true;
}

async function revisarPacientesPersonales(hoy) {
  let avisos = 0;
  const usuarios = await db.collection("users").listDocuments();
  console.log(`Revisando ${usuarios.length} cuenta(s) personal(es)...`);

  for (const usuarioRef of usuarios) {
    const configDoc = await usuarioRef.collection("data").doc("config").get();
    const tokens = configDoc.exists ? configDoc.data()?.value?.fcmTokens || [] : [];

    const pacientesSnap = await usuarioRef
      .collection("patients")
      .where("proximaVisita", "==", hoy)
      .get();

    for (const patientDoc of pacientesSnap.docs) {
      const seEnvio = await enviarSiCorresponde(patientDoc, hoy, tokens, `users/${usuarioRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

async function revisarPacientesDeClinicas(hoy) {
  let avisos = 0;
  const clinicas = await db.collection("clinics").listDocuments();
  console.log(`Revisando ${clinicas.length} clínica(s) compartida(s)...`);

  for (const clinicaRef of clinicas) {
    // Se junta el token de TODOS los doctores cuyo config.clinicaId apunte a
    // esta clínica, para avisarle a todo el equipo.
    const usuarios = await db.collection("users").listDocuments();
    const tokens = [];
    for (const usuarioRef of usuarios) {
      const configDoc = await usuarioRef.collection("data").doc("config").get();
      const valor = configDoc.exists ? configDoc.data()?.value : null;
      if (valor?.clinicaId === clinicaRef.id && Array.isArray(valor.fcmTokens)) {
        tokens.push(...valor.fcmTokens);
      }
    }
    const tokensUnicos = [...new Set(tokens)];

    const pacientesSnap = await clinicaRef
      .collection("patients")
      .where("proximaVisita", "==", hoy)
      .get();

    for (const patientDoc of pacientesSnap.docs) {
      const seEnvio = await enviarSiCorresponde(patientDoc, hoy, tokensUnicos, `clinics/${clinicaRef.id}`);
      if (seEnvio) avisos++;
    }
  }
  return avisos;
}

async function main() {
  const hoy = hoyComoTexto();
  console.log(`Revisando citas para el día ${hoy}...`);

  const avisosPersonales = await revisarPacientesPersonales(hoy);
  const avisosClinicas = await revisarPacientesDeClinicas(hoy);

  console.log(`Listo. Avisos mandados en esta corrida: ${avisosPersonales + avisosClinicas}.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("Error general del robot de notificaciones:", e);
    process.exit(1);
  });
